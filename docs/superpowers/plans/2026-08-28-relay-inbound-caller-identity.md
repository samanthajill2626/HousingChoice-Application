<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-09-01).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). The mission's review record is preserved at
> `docs/superpowers/reviews/2026-08-28-relay-inbound-caller-identity/`.

# Relay Inbound Caller Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans` to
> implement this plan task by task. Track every checkbox in the mission ledger.

**Goal:** For new non-member calls to a relay group number, retain the normalized
caller number and an optional arrival-time contact match, then show staff who tried
to call the relay number and that the call was not connected.

**Architecture:** The existing Twilio voice route remains the sole owner of relay
resolution, membership, and bridge-versus-refusal behavior. After that route has
already computed `reason === 'non_member'`, it performs one best-effort contact
lookup and passes three optional facts through the existing `messages.append`
funnel. The authenticated messages endpoint hydrates a current display name only
from the stored contact ID. The Relay mapper carries the approved metadata into a
pure presentation seam, and the existing call card renders the special summary,
chip, and collapsed details.

**Tech stack:** TypeScript, Express, DynamoDB document client, React 19, React
Router 7, Vitest/Testing Library, Playwright, and the existing fake Twilio voice
engine. No new dependency, table, index, migration, backfill, feature flag, or
infrastructure change.

**Spec:**
`docs/superpowers/specs/2026-08-28-relay-inbound-caller-identity-design.md`
at approved commit `b9c28a41`.

**Status:** Draft for adversarial plan review.

## Global constraints

- The call is already inbound. Keep `direction: 'inbound'`; do not add a second
  direction or describe Twilio as calling the relay number.
- Do not change `resolveRelayInbound`, its selected group, roster membership,
  caller/callee selection, the refusal branch condition, refusal-reason
  precedence, or bridge-versus-hangup behavior.
- Do not add a refusal recorder, service, or repository operation. The existing
  `handleMaskedInbound` and existing `messages.append` call remain the path.
- Add the three facts only after the voice handler has already computed
  `reason === 'non_member'`. `closed_thread`, `no_callee`, and `no_pool_number`
  rows remain byte-for-byte unchanged with respect to these fields.
- The new persisted attributes are exactly
  `relay_refusal_reason: 'non_member'`, `relay_external_caller_phone`, and
  `relay_external_caller_contact_id`. Store no rendered sentence, formatted
  phone, or contact name.
- Normalize `From` with `normalizeToE164`. Do not persist withheld, anonymous,
  malformed, or otherwise non-normalizable raw values.
- Match an existing contact once at arrival with `contacts.findByPhone`. Store its
  ID only when the result is not soft-deleted. Never create a contact, change a
  contact, change the relay roster, or perform a read-time phone match.
- The new `findByPhone` lookup is best-effort. A lookup failure still stores the
  normalized phone, still uses the existing CallSid idempotency path, and still
  returns the existing masked `Say` plus `Hangup` TwiML.
- A contact match is display metadata only. `author` remains `unknown`,
  `relay_sender_key` remains absent, and no participant leg is created.
- The staff card face is exactly one of: `<name> tried to call this relay number`,
  `<formatted phone> tried to call this relay number`, or
  `An unknown caller tried to call this relay number`.
- Only a row with `relay_refusal_reason === 'non_member'` gets the `Not connected`
  chip and the new presentation. Existing member `A called B`, ordinary inbound
  `Incoming call`, and every historical row without the new reason remain
  unchanged.
- Details stay collapsed by default and contain the phone or
  `Caller ID unavailable`, `Not a participant in this relay group`, `View contact`
  or `No linked contact`, and a full local date/time with seconds. The contact
  link exists only when the stored ID currently resolves to a non-deleted named
  contact.
- The external phone is staff/developer data, not participant-facing data. Do not
  add it to TwiML, participant dial targets, bridged caller ID, participant
  messages/notifications, `call_party_label`, or `relay_sender_key`.
- Only calls ingested after deployment get these facts. Do not backfill or alter
  the existing production rows.
- New and touched lines in code, tests, docs, prompts, and test names are
  ASCII-only.
- Never deploy, mutate infrastructure, push secrets, merge into `main`, or clean
  up the branch/worktree. Those remain human-owned.

## Work map

- **S1 - Durable write contract:** `NewMessage` and `MessageItem` fields,
  append-level storage-shape guards, snake-case mapping, and fake-repo parity.
- **S2 - Existing voice refusal branch:** best-effort normalization/contact match
  after `non_member`, with no routing or TwiML change.
- **S3 - Authenticated read enrichment:** ID-only batched display hydration,
  deletion fence, failure fallback, and no stored-object mutation.
- **S4 - Dashboard mapping and pure presentation:** wire types, relay mapper,
  identity precedence, `Not connected`, and precise time formatting.
- **S5 - Call-card UI:** exact face copy, collapsed details, accessible unique
  controls, contact link, and unchanged legacy/member calls.
- **E1 - Real flow proof:** fake inbound non-member call to a real open relay group,
  no participant leg, staff UI display/details, and no contact creation.
- **E2 - Completion proof:** full bare gates, touched-file ESLint ratchet,
  independent review, and live hermetic QA.

## Task 1: Add the durable append contract and storage-shape guard

**Files:**

- Modify `app/src/repos/messagesRepo.ts`
- Modify `app/test/repos.test.ts`
- Modify `app/test/helpers/twilioWebhookHarness.ts`

**Produces:**

```ts
// NewMessage
relayRefusalReason?: 'non_member';
relayExternalCallerPhone?: string;
relayExternalCallerContactId?: string;

// MessageItem
relay_refusal_reason?: 'non_member';
relay_external_caller_phone?: string;
relay_external_caller_contact_id?: string;
```

- [ ] **Step 1.1: Write failing repository tests before production code**

In `app/test/repos.test.ts`, add a fake document client that records every
`TransactWriteCommand`. Use this valid base input:

```ts
const nonMemberCall = {
  conversationId: 'conv-relay',
  providerSid: 'CAexternal1',
  providerTs: '2026-08-28T16:21:16.000Z',
  type: 'call' as const,
  direction: 'inbound' as const,
  author: 'unknown' as const,
  deliveryStatus: 'delivered' as const,
  callStatus: 'no-answer' as const,
  callOutcome: 'missed' as const,
  masked: true,
  relayRefusalReason: 'non_member' as const,
  relayExternalCallerPhone: '+16175550198',
  relayExternalCallerContactId: 'contact-external',
};
```

Assert the first transaction item persists all three exact snake-case fields.
Append a second valid input that keeps only
`relayRefusalReason: 'non_member'` from the three new fields. Assert the real
transaction persists the reason and omits both
`relay_external_caller_phone` and `relay_external_caller_contact_id`. This pins
the approved anonymous-caller state at the production repository boundary.
Then table-drive invalid shapes and assert each rejects before the fake client is
called. Cast each deliberately invalid object through `unknown` to `NewMessage`
so TypeScript does not hide the runtime-boundary test:

```ts
[
  { ...nonMemberCall, type: 'sms' },
  { ...nonMemberCall, direction: 'outbound' },
  { ...nonMemberCall, masked: false },
  { ...nonMemberCall, relayRefusalReason: undefined },
  { ...nonMemberCall, relayExternalCallerPhone: '617-555-0198' },
  { ...nonMemberCall, relayExternalCallerPhone: undefined },
  { ...nonMemberCall, relaySenderKey: 'contact-member' },
  { ...nonMemberCall, author: 'tenant' },
]
```

The `relayExternalCallerPhone: undefined` case still carries a contact ID and
therefore pins the contact-ID-requires-phone rule. Also assert a normal call and a
normal SMS with none of the three fields still append successfully and do not gain
the attributes.

- [ ] **Step 1.2: Run the focused repository test and prove red**

```powershell
npm run test -w @housingchoice/app -- test/repos.test.ts
```

Expected: exit 1 because the new fields are absent and invalid combinations are
not rejected.

- [ ] **Step 1.3: Implement one storage-only guard and field mapping**

Import `isE164` from `app/src/lib/phone.ts`. Add the optional fields beside the
existing voice-call fields on `NewMessage` and `MessageItem`. Immediately inside
`append`, before computing the key or constructing a transaction, enforce this
shape:

```ts
function assertRelayExternalCallerShape(message: NewMessage): void {
  const hasReason = message.relayRefusalReason !== undefined;
  const hasPhone = message.relayExternalCallerPhone !== undefined;
  const hasContactId = message.relayExternalCallerContactId !== undefined;
  if (!hasReason && !hasPhone && !hasContactId) return;

  const valid =
    message.type === 'call' &&
    message.direction === 'inbound' &&
    message.masked === true &&
    message.relayRefusalReason === 'non_member' &&
    message.author === 'unknown' &&
    message.relaySenderKey === undefined &&
    (!hasPhone || isE164(message.relayExternalCallerPhone as string)) &&
    (!hasContactId || hasPhone);

  if (!valid) {
    throw new TypeError('invalid relay external caller metadata');
  }
}
```

Do not read a conversation, inspect a roster, derive a reason, or decide routing
in this function. After the guard passes, map the fields exactly:

```ts
...(message.relayRefusalReason !== undefined && {
  relay_refusal_reason: message.relayRefusalReason,
}),
...(message.relayExternalCallerPhone !== undefined && {
  relay_external_caller_phone: message.relayExternalCallerPhone,
}),
...(message.relayExternalCallerContactId !== undefined && {
  relay_external_caller_contact_id: message.relayExternalCallerContactId,
}),
```

Narrow the existing comments that say masked calls never contain a raw
counterpart phone: `call_party_label`, roster attribution, recordings,
transcripts, and participant surfaces remain phone-free; the explicit normalized
external-caller field is the one approved staff-only exception.

Mirror the three optional mappings in the in-memory `messagesRepo.append` inside
`app/test/helpers/twilioWebhookHarness.ts`. The real-repository test owns the
runtime rejection contract; the fake must expose the persisted fields so route and
API tests observe the same storage names.

- [ ] **Step 1.4: Run focused repository tests and app typecheck**

```powershell
npm run test -w @housingchoice/app -- test/repos.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both exit 0.

- [ ] **Step 1.5: Commit only Task 1 files**

Run bare `git status`, verify `.git/MERGE_HEAD` is absent, stage the three explicit
paths, and commit:

```powershell
git commit -m "feat: store relay refusal caller facts" -m "Co-Authored-By: OpenAI Codex <codex@openai.com>" -- app/src/repos/messagesRepo.ts app/test/repos.test.ts app/test/helpers/twilioWebhookHarness.ts
```

## Task 2: Capture identity only in the existing non-member refusal branch

**Files:**

- Modify `app/src/routes/webhooks/voice.ts`
- Modify `app/test/voiceWebhook.test.ts`

- [ ] **Step 2.1: Strengthen the real signed-webhook tests first**

Extend the existing refusal tests in `app/test/voiceWebhook.test.ts`; do not create
a second route harness. Pin these cases:

1. A non-member valid E.164 caller stores `relay_refusal_reason: 'non_member'`
   and `relay_external_caller_phone`, no contact ID, `author: 'unknown'`, and no
   `relay_sender_key`; the response contains `Hangup`, no `Dial`, and no phone.
2. A matching non-deleted contact stores its ID but still has unknown author and
   no roster key.
3. A matching soft-deleted contact stores the phone and no contact ID.
4. `From: 'anonymous'` stores the reason but neither phone nor contact ID.
5. Override `world.contactsRepo.findByPhone` to reject with an error whose message
   contains the test E.164 number. The route still returns the existing refusal
   TwiML and appends one phone-only call row. Select the captured warning by its
   exact message and assert its serialized record contains neither the raw E.164
   number nor its formatted form; make the same assertions against the TwiML.
6. Redeliver the same CallSid after adding a matching contact. The first unmatched
   row remains unchanged and no second row is appended.
7. Closed-thread, one-member (`no_callee`), and forced missing-pool
   (`no_pool_number`) refusals append none of the new attributes. For the corrupt
   missing-pool case, override `getAllByPoolNumber` to return a selected open relay
   whose `pool_number` is absent; do not change production resolution to make the
   branch reachable.

Every case must continue asserting the existing refusal response and the absence
of `<Dial>`. Existing open-member bridge tests remain untouched and green.

- [ ] **Step 2.2: Run the voice webhook file and prove red**

```powershell
npm run test -w @housingchoice/app -- test/voiceWebhook.test.ts
```

Expected: exit 1 because the refusal row carries no external caller facts.

- [ ] **Step 2.3: Add the best-effort lookup after the existing decision**

In `handleMaskedInbound`, leave this existing decision code and its order intact:

```ts
const caller = roster.find((m) => m.phone === From);
const callees = roster.filter((m) => m.phone !== From);
const isClosed = relay.status !== 'open';
if (isClosed || !caller || typeof poolNumber !== 'string' || poolNumber.length === 0 || callees.length === 0) {
  const reason = isClosed
    ? 'closed_thread'
    : !caller
      ? 'non_member'
      : callees.length === 0
        ? 'no_callee'
        : 'no_pool_number';
  // Add the new lookup here, then continue through the existing append/TwiML.
}
```

Import `normalizeToE164` beside `formatPhoneForDisplay`, and import `isDeleted`
beside the contact repository types. Immediately after `reason` is computed, add:

```ts
let relayExternalCallerPhone: string | undefined;
let relayExternalCallerContactId: string | undefined;
if (reason === 'non_member') {
  relayExternalCallerPhone = normalizeToE164(From);
  if (relayExternalCallerPhone !== undefined) {
    try {
      const matched = await contacts.findByPhone(relayExternalCallerPhone);
      if (matched !== undefined && !isDeleted(matched)) {
        relayExternalCallerContactId = matched.contactId;
      }
    } catch {
      log.warn(
        { callSid: CallSid },
        'masked call refusal: external caller contact lookup failed',
      );
    }
  }
}
```

Do not include the caught error, `From`, or the normalized phone in the new log;
dependency errors can echo their lookup input. Add only these conditional
properties to the existing `messages.append` object:

```ts
...(reason === 'non_member' && { relayRefusalReason: 'non_member' as const }),
...(relayExternalCallerPhone !== undefined && { relayExternalCallerPhone }),
...(relayExternalCallerContactId !== undefined && { relayExternalCallerContactId }),
```

Do not move or rewrite the append catch, event emission, info log, `Say`, `Hangup`,
bridge branch, `<Dial>`, caller ID, or call lifecycle fields.

- [ ] **Step 2.4: Run the affected server tests and app typecheck**

```powershell
npm run test -w @housingchoice/app -- test/voiceWebhook.test.ts test/repos.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both exit 0.

- [ ] **Step 2.5: Commit only Task 2 files**

```powershell
git commit -m "feat: retain non-member relay caller identity" -m "Co-Authored-By: OpenAI Codex <codex@openai.com>" -- app/src/routes/webhooks/voice.ts app/test/voiceWebhook.test.ts
```

## Task 3: Hydrate the current contact name on the authenticated read

**Files:**

- Modify `app/src/repos/contactsRepo.ts`
- Modify `app/src/routes/api.ts`
- Modify `app/test/helpers/twilioWebhookHarness.ts`
- Modify `app/test/contactsRepo.integration.test.ts`
- Modify `app/test/conversationHubApi.test.ts`

**Produces:** response-only
`relay_external_caller_display_name?: string`.

- [ ] **Step 3.1: Write the display-projection and route tests first**

In `app/test/contactsRepo.integration.test.ts`, create then soft-delete a contact
and prove `getDisplayById` and `getDisplaysByIds` include its `deleted_at` stamp.
The display projection must remain limited to contact ID, first name, last name,
phone, and deletion stamp.

In the existing `GET /api/conversations/:conversationId/messages` describe block,
add route cases that append call rows through the fake repo and assert:

- two rows with one repeated external contact ID trigger exactly one
  `getDisplaysByIds` call with one unique ID and receive the trimmed current name;
- a page with no external contact IDs makes zero display reads;
- a missing display row returns the full page without a response-only name;
- a soft-deleted display row omits the name, and clearing `deleted_at` makes the
  next request return the current name and linkable ID;
- a rejected batch read returns HTTP 200 with the full unhydrated page;
- the original `world.messages` objects never gain
  `relay_external_caller_display_name`.

Use `vi.spyOn(world.contactsRepo, 'getDisplaysByIds')` for call counts and a
rejected-read seam. Do not add a phone lookup to the GET route.

- [ ] **Step 3.2: Run the focused tests and prove red**

```powershell
npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts test/conversationHubApi.test.ts
```

Expected: exit 1 because the projection lacks `deleted_at` and the messages route
returns stored rows without hydration.

- [ ] **Step 3.3: Extend only the shared display projection**

Add `deleted_at?: string` to `ContactDisplayItem`. Extend
`DISPLAY_PROJECTION` with `#deletedAt` mapped to `deleted_at`. Update the harness
`projectDisplay` helper to copy a non-empty `deleted_at`, so route tests model the
real projection rather than returning whole contact items.

- [ ] **Step 3.4: Add bounded, best-effort ID-only hydration**

After `messages.listByConversation` returns its page:

```ts
const contactIds = [...new Set(
  page.flatMap((message) =>
    typeof message.relay_external_caller_contact_id === 'string' &&
    message.relay_external_caller_contact_id.length > 0
      ? [message.relay_external_caller_contact_id]
      : [],
  ),
)];
```

If the list is non-empty, call `contacts.getDisplaysByIds(contactIds)` exactly
once inside a local try/catch. On failure, warn with `conversationId` and the
requested count, then return the original complete page. Do not log IDs, names,
or phones.

Map rather than mutate the stored objects. For each matching display row, skip it
when missing or `isDeleted(contact)` is true. Derive a name defensively:

```ts
const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
const displayName = [first, last].filter((part) => part.length > 0).join(' ');
```

Only when `displayName` is non-empty return a spread copy containing
`relay_external_caller_display_name`. Leave `GET /api/calls/:callId` as the
authenticated raw stored call response and update its stale privacy comment to
acknowledge the explicit staff-only field.

- [ ] **Step 3.5: Run the focused server tests and typecheck**

```powershell
npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts test/conversationHubApi.test.ts test/voiceWebhook.test.ts test/repos.test.ts
npm run typecheck -w @housingchoice/app
```

Expected: both exit 0. If DynamoDB Local is unavailable, start it with
`npm run db:start`; do not accept a skipped integration test as proof.

- [ ] **Step 3.6: Commit only Task 3 files**

```powershell
git commit -m "feat: hydrate relay caller display names" -m "Co-Authored-By: OpenAI Codex <codex@openai.com>" -- app/src/repos/contactsRepo.ts app/src/routes/api.ts app/test/helpers/twilioWebhookHarness.ts app/test/contactsRepo.integration.test.ts app/test/conversationHubApi.test.ts
```

## Task 4: Carry the wire facts into pure dashboard presenters

**Files:**

- Modify `dashboard/src/api/types.ts`
- Modify `dashboard/src/routes/conversation/useRelayThread.ts`
- Modify `dashboard/src/routes/conversation/useRelayThread.test.tsx`
- Create `dashboard/src/routes/contact/presentRelayExternalCaller.ts`
- Create `dashboard/src/routes/contact/presentRelayExternalCaller.test.ts`
- Modify `dashboard/src/routes/contact/presentCallState.ts`
- Modify `dashboard/src/routes/contact/presentCallState.test.ts`
- Modify `dashboard/src/routes/contact/format.ts`
- Modify `dashboard/src/routes/contact/format.test.ts`

- [ ] **Step 4.1: Write failing mapper, identity, state, and formatter tests**

Extend the raw `Message` and `TimelineCall` fixtures to exercise all four fields:

```ts
relay_refusal_reason: 'non_member',
relay_external_caller_phone: '+16175550198',
relay_external_caller_contact_id: 'contact-external',
relay_external_caller_display_name: 'Morgan Lee',
```

Assert `toTimelineMessage` carries those exact fields while still dropping
provider IDs, recording, transcript, and media. Assert a historical call without
the reason remains unchanged.

Create a pure presenter with this contract:

```ts
export interface RelayExternalCallerPresentation {
  summary: string;
  phoneLabel: string;
  linkedContactId?: string;
}

export function presentRelayExternalCaller(
  call: Pick<
    TimelineCall,
    | 'relay_refusal_reason'
    | 'relay_external_caller_phone'
    | 'relay_external_caller_contact_id'
    | 'relay_external_caller_display_name'
  >,
): RelayExternalCallerPresentation | undefined;
```

Table-drive exact precedence and copy:

- name + ID + phone -> `Morgan Lee tried to call this relay number`, formatted
  phone, and `linkedContactId`;
- phone only -> `(617) 555-0198 tried to call this relay number`, formatted phone,
  and no link;
- stored ID whose name is absent -> phone summary and no link;
- neither phone nor usable name ->
  `An unknown caller tried to call this relay number` and
  `Caller ID unavailable`;
- display name without a stored contact ID -> ignore the name and fall back;
- any row without the non-member reason -> `undefined`.

Extend `presentCallState` tests so `relayRefusalReason: 'non_member'` returns
`{ label: 'Not connected', tone: 'danger' }` before voicemail, ringing, status,
or stored missed-outcome clauses. Existing inputs with the optional field absent
retain every current matrix result.

Add `formatDateTimeWithSeconds` tests for a clean local instant, an
`<ISO>#<suffix>` value, and invalid input returning exactly `Time unavailable`.

- [ ] **Step 4.2: Run the focused dashboard tests and prove red**

```powershell
npm run test -w @housingchoice/dashboard -- src/routes/conversation/useRelayThread.test.tsx src/routes/contact/presentRelayExternalCaller.test.ts src/routes/contact/presentCallState.test.ts src/routes/contact/format.test.ts
```

Expected: exit 1 because the new presenter/module/fields do not exist.

- [ ] **Step 4.3: Add wire types and mapper fields**

Add the three persisted fields plus the response-only display name to the call
section of `Message`. Add the same four optional fields to `TimelineCall`. In
`toTimelineMessage`, copy `relay_refusal_reason` only when it is exactly
`'non_member'`; conditionally copy only string values for the other three fields.
Keep its media/provider/transcript omission intact.

- [ ] **Step 4.4: Implement the pure identity and call-state presenters**

In `presentRelayExternalCaller.ts`, return `undefined` unless the reason is exactly
`non_member`. Trim the hydrated display name, but use it only when a non-empty
stored contact ID is also present. Otherwise fall back to the formatted stored
phone, then the exact unknown-caller sentence. Never examine the current roster or
look up a phone.

Add `relayRefusalReason?: 'non_member'` to `CallStateInput` and make it the first
presentation clause:

```ts
if (relayRefusalReason === 'non_member') {
  return { label: 'Not connected', tone: 'danger' };
}
```

Implement the full local date/time formatter beside the compact clock formatter:

```ts
export function formatDateTimeWithSeconds(iso: string): string {
  const d = new Date(isoOf(iso));
  if (Number.isNaN(d.getTime())) return 'Time unavailable';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}
```

- [ ] **Step 4.5: Run focused tests and dashboard typecheck**

```powershell
npm run test -w @housingchoice/dashboard -- src/routes/conversation/useRelayThread.test.tsx src/routes/contact/presentRelayExternalCaller.test.ts src/routes/contact/presentCallState.test.ts src/routes/contact/format.test.ts
npm run typecheck -w @housingchoice/dashboard
```

Expected: both exit 0.

- [ ] **Step 4.6: Commit only Task 4 files**

```powershell
git commit -m "feat: present relay external caller facts" -m "Co-Authored-By: OpenAI Codex <codex@openai.com>" -- dashboard/src/api/types.ts dashboard/src/routes/conversation/useRelayThread.ts dashboard/src/routes/conversation/useRelayThread.test.tsx dashboard/src/routes/contact/presentRelayExternalCaller.ts dashboard/src/routes/contact/presentRelayExternalCaller.test.ts dashboard/src/routes/contact/presentCallState.ts dashboard/src/routes/contact/presentCallState.test.ts dashboard/src/routes/contact/format.ts dashboard/src/routes/contact/format.test.ts
```

## Task 5: Render the approved call-card face and collapsed details

**Files:**

- Modify `dashboard/src/routes/contact/Timeline.tsx`
- Modify `dashboard/src/routes/contact/Timeline.test.tsx`
- Modify `dashboard/src/routes/contact/Timeline.module.css` only if the existing
  `.cardMeta` layout cannot express separate detail rows

- [ ] **Step 5.1: Add failing Timeline integration tests**

Use the existing Relay roster render harness. Add exact call-card cases for:

1. matched current contact name on the face, `Not connected`, details initially
   collapsed, then formatted phone + `View contact` + non-member explanation +
   precise time after activation;
2. unmatched phone on the face, no contact link, and `No linked contact` in details;
3. caller ID unavailable with the exact unknown-caller sentence and an always
   present Details button;
4. stored ID with no hydrated name falling back to phone and no link;
5. a non-member reason whose current roster contains the same phone still using
   the stored external presentation, never `A called B`;
6. two calls in one minute producing distinct group names and Details controls
   through seconds precision;
7. historical generic inbound and current member `A called B` cards retaining
   their current face, state, and details behavior.

Use accessibility-first selectors. Assert the contact link has exact href
`/contacts/contact-external`; the card face itself is plain text, not a link.
Because the dashboard Vitest configuration does not apply CSS visibility, pin the
collapsed state through `aria-expanded="false"` and absence of the
`cardRevealed` class, then pin the revealed state through `aria-expanded="true"`
and presence of `cardRevealed`. Do not use a visibility assertion that can pass
while `.cardMeta` is present without the production stylesheet.

- [ ] **Step 5.2: Run the Timeline test and prove red**

```powershell
npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx
```

Expected: exit 1 because `CallCard` still renders the generic incoming summary and
missed state.

- [ ] **Step 5.3: Integrate the presenters without changing ordinary calls**

In `CallCard`:

```ts
const externalCaller = presentRelayExternalCaller(call);
const state = presentCallState({
  direction: call.direction,
  callStatus: call.call_status,
  callOutcome: call.call_outcome,
  relayRefusalReason: call.relay_refusal_reason,
  at: call.at,
  now,
});
const relaySummary = relayCallSummary(call, relayRoster);
const callWho = externalCaller?.summary ?? relaySummary ?? directionWord;
```

Keep the visible minute clock and the existing seconds-precision `cardName` logic.
For an external caller, make the existing Details button present regardless of
phone availability. Its card-scoped accessible name continues to use `cardName`.
Render these separate rows inside the existing hidden `.cardMeta` container:

```tsx
<div>{externalCaller.phoneLabel}</div>
<div>Not a participant in this relay group</div>
{externalCaller.linkedContactId !== undefined ? (
  <Link to={`/contacts/${encodeURIComponent(externalCaller.linkedContactId)}`}>
    View contact
  </Link>
) : (
  <div>No linked contact</div>
)}
<div>{formatDateTimeWithSeconds(call.at)}</div>
```

For non-external calls, preserve the current `party_phone` detail string and
recording/transcript behavior exactly. Do not render duration when it is absent.
Do not make the face a navigation target. Add CSS only if necessary for row spacing;
reuse `.cardMeta` and `.cardRevealed .cardMeta` for the collapsed behavior.

- [ ] **Step 5.4: Run all affected dashboard tests and typecheck**

```powershell
npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/contact/presentRelayExternalCaller.test.ts src/routes/contact/presentCallState.test.ts src/routes/contact/format.test.ts src/routes/conversation/useRelayThread.test.tsx
npm run typecheck -w @housingchoice/dashboard
```

Expected: both exit 0.

- [ ] **Step 5.5: Commit only Task 5 files**

Run bare `git status` first. Include `Timeline.module.css` only if actually changed:

```powershell
git commit -m "feat: explain unconnected relay calls" -m "Co-Authored-By: OpenAI Codex <codex@openai.com>" -- dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.test.tsx dashboard/src/routes/contact/Timeline.module.css
```

## Task 6: Prove the real inbound-to-dashboard flow

**Files:**

- Create `e2e/tests/dashboard-next/relay-inbound-caller-identity.spec.ts`

- [ ] **Step 6.1: Write the focused Playwright spec**

Use `createGroupOpen`, `placeCall`, `listCalls`, the standard VA dev login, and a
per-run-unique E.164 number that is not one of the two group members. The spec must:

1. reseed lean and authenticate after reseeding;
2. create one open two-member relay group with its real pool number;
3. call that pool number from the non-contact/non-member phone through
   `fake-twilio`'s `/control/place-call` seam;
4. assert the fake call has zero `legs`, proving the app returned no `<Dial>`;
5. poll the authenticated messages endpoint until the CallSid row carries the
   non-member reason and normalized phone, with no contact ID;
6. navigate to `/conversations/<conversationId>` and assert the exact
   `<formatted phone> tried to call this relay number` face plus `Not connected`;
7. activate the card-specific Details button and assert the formatted phone,
   `No linked contact`, `Not a participant in this relay group`, and a visible
   full date/time with seconds;
8. query `/api/contacts?phone=<encoded phone>` and assert no contact exists; and
9. reseed lean in `afterAll` so the file does not leave a special world behind.

Import the shared dashboard `formatPhoneDisplay` helper for the expected face; do
not duplicate number formatting in the test. Use roles/labels for UI selectors.

- [ ] **Step 6.2: Run the focused browser spec and prove red or green honestly**

```powershell
npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/relay-inbound-caller-identity.spec.ts
```

Expected after Tasks 1-5: exit 0. If it fails, preserve the Playwright artifacts
before rerunning and diagnose the exact failed contract. Do not run a root/stray
Playwright command and do not use ports 5174/8080.

- [ ] **Step 6.3: Commit the focused E2E proof**

```powershell
git commit -m "test: prove relay caller identity end to end" -m "Co-Authored-By: OpenAI Codex <codex@openai.com>" -- e2e/tests/dashboard-next/relay-inbound-caller-identity.spec.ts
```

## Task 7: Final sync, complete gates, and handback evidence

- [ ] **Step 7.1: Verify a quiet tree and sync current `main` exactly once**

Stop every child/fix wave first. Run bare `git status` and inspect current `main`
drift. If `main` advanced and the merge could conflict with active work, report
`STATUS: QUESTION` and ask before syncing. Otherwise merge current `main` into the
feature branch once, preserve both sides' intent, resolve deliberately, and commit
the merge if needed. Never merge the feature branch into `main`.

- [ ] **Step 7.2: Run the required bare gates from this worktree**

Before validation, report the lane as a HousingChoice feature mission and state the
exact checks below. Run each command separately, without a pipe:

```powershell
npm run typecheck
npm test
npm run smoke
npm run e2e
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

If the touched-file list is empty, skip ESLint rather than invoking it repo-wide.
If `npm test` is red first on DynamoDB Local suites, rerun the app suite under a
clean access key before attributing the failure:

```powershell
cd app
$env:AWS_ACCESS_KEY_ID='hccleanrun001'
npx vitest run
```

Report every real exit code and test count. Attribute any lint or test failure by
baseline comparison, not by line number or intuition.

- [ ] **Step 7.3: Perform live hermetic UI QA**

Start `npm run e2e:session` only after the full suite is stopped. Confirm the
session's positive lane through `/__dev/ping`, log in after any reseed, reproduce
one unmatched non-member call, and visually verify the face, chip, collapsed and
expanded details, contact-link absence, and no layout overflow at desktop and a
representative mobile width. Stop the session with `npm run e2e:stop` after QA.

- [ ] **Step 7.4: Hand back, unmerged**

Write `.superpowers/sdd/handback.md` with the work map, commits, focused proofs,
bare gate exit codes/counts, touched-file ESLint result, live QA evidence, reviewer
findings/adjudications, current `main` drift, and post-merge obligations (`none
expected`). State explicitly that the branch is unmerged and that deployment and
production validation remain human-owned.
