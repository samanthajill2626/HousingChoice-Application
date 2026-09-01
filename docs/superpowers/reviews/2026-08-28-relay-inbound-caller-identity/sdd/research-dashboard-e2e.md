# Dashboard and focused E2E research - relay inbound caller identity

## Scope and tree state

Read-only Phase 1 mapping for the approved feature. Worktree was on
`feat/relay-inbound-caller-identity` with no application-file changes observed
from this research. The dashboard contract has one API type, one relay mapper,
one shared call-card renderer, and one focused real-stack voice proof. No
live-tree drift requires a product or architectural change to the approved
spec/plan.

## Dashboard data path and complete reader/render inventory

| Surface | Exact anchor | What must change / stay true |
| --- | --- | --- |
| Raw authenticated message wire type | `dashboard/src/api/types.ts:2102-2163` | Add the three durable fields and response-only display name in the call section of `Message`. This type is consumed by `getConversationMessages`; there is no separate relay API payload type. |
| Safe relay-to-timeline mapper | `dashboard/src/routes/conversation/useRelayThread.ts:66-116` | `toTimelineMessage` is the only relay call mapper. It currently forwards only ordinary metadata and intentionally excludes provider IDs, recording, transcript, and media. Preserve that exclusion. Copy `relay_refusal_reason` only when exactly `non_member`; copy only string values for phone, contact ID, and hydrated display name. Its exported unit test is the direct wiring proof. |
| Shared call display model | `dashboard/src/api/types.ts:2338-2371` | Add the same four optional fields to `TimelineCall`. `TimelineCall` is only rendered by the shared `Timeline` call-card path; repo-wide reader search found no second TimelineCall renderer. |
| Ordinary relay attribution | `dashboard/src/routes/contact/Timeline.tsx:1161-1193` | `relayCallSummary` resolves a current roster member and yields `A called B`. The new external-caller presenter must win before this fallback, otherwise the current-roster phone-match case can incorrectly attribute the external caller. Keep this function unchanged for historical/member rows. |
| Call-card state and disclosure | `dashboard/src/routes/contact/Timeline.tsx:1195-1315` | `CallCard` is the only call-card renderer. It is the snake_case-to-camelCase state-presentation seam. External calls need `Not connected` to win at `presentCallState`, the approved face copy to win over `relayCallSummary`, and a disclosure even when there is no phone. |
| Call-state presenter | `dashboard/src/routes/contact/presentCallState.ts:42-185` | Add optional `relayRefusalReason` and make exact `non_member` the first clause. Existing cancellation/refusal semantics remain untouched for rows without that field. |
| Phone/time presentation | `dashboard/src/routes/contact/format.ts:13-53` | `formatPhone` delegates to the dashboard shared E.164 formatter. Existing `formatTimeWithSeconds` deliberately returns empty on invalid input for accessible names; add a separate full `formatDateTimeWithSeconds` that returns `Time unavailable` for the disclosure. Do not change the accessible-name formatter contract. |
| Timeline tests and CSS reveal contract | `dashboard/src/routes/contact/Timeline.test.tsx:1919-2228`; `dashboard/src/routes/contact/Timeline.module.css:492-505` | Existing tests establish that CSS is not applied by Vitest. Prove collapsed/revealed through `aria-expanded` and the `cardRevealed` class, not `toBeVisible` before click. Reuse the existing card-scoped `.cardMeta` reveal selector; no CSS change is needed unless visual QA shows desired row spacing is missing. |

## Accessibility and UI implementation anchors

- A call card is `role="group"` and its accessible name is `cardName` at
  `Timeline.tsx:1275-1286`. It must continue to include seconds, because same-minute
  call cards otherwise collide. The external caller summary will become the leading
  text in this stable handle; its outcome chip remains excluded from the handle.
- The disclosure is a real button named `Details for <cardName>` at
  `Timeline.tsx:1299-1312`. It has `aria-expanded`, and the card gets
  `cardRevealed` at `Timeline.tsx:1277`. Scope E2E interactions through the one
  external-caller card group, then ask that group for its Details button.
- The existing no-details rule at `Timeline.tsx:1266-1273` is specific to a masked
  call with no releasable identity. It must be widened only through the external
  presentation: non-member rows always have a details disclosure, including caller
  ID unavailable.
- `Timeline` owns the named region `Communications and activity` at
  `Timeline.tsx:1983`; use it to scope browser assertions. `ConversationDetail`
  passes the relay roster and the live thread directly into this shared Timeline at
  `dashboard/src/routes/conversation/ConversationDetail.tsx:480-498`.
- Existing routing/card tests already use the correct pattern:
  `screen.getByRole('group', { name: ... })`, then card-scoped Details lookup;
  see `Timeline.test.tsx:2087-2116` and `2169-2197`.

## Test surfaces

### Unit and component tests

1. Extend `dashboard/src/routes/conversation/useRelayThread.test.tsx` near the
   current call case at lines 62-90. Pin all four values through the mapper and
   pin that provider/media/transcript fields remain omitted.
2. Create `presentRelayExternalCaller.test.ts` as a table for exact precedence:
   valid current name plus stored ID, phone-only, stale/missing ID name fallback,
   absent caller ID, and no `non_member` reason. The presenter must never look at
   the roster or do a phone lookup.
3. Extend `presentCallState.test.ts` to show `non_member` wins over voicemail,
   ringing, and stored outcome/status inputs; retain the existing matrix unchanged
   when the new field is absent.
4. Extend `format.test.ts` with full local date/time, sortable `<ISO>#suffix`, and
   invalid input. Keep existing `formatTimeWithSeconds` invalid-input tests at
   lines 63-79 unchanged.
5. Extend the focused `Timeline.test.tsx` call-card block at lines 1937-2228:
   name card, phone-only card, unavailable caller ID card, stored-ID/no-name
   fallback, a matching current roster phone that must not render `A called B`,
   same-minute unique accessible names, and ordinary inbound/member regressions.
   For the matched contact, assert `View contact` has exactly
   `/contacts/contact-external`; card face remains text, not a link.

### Focused browser proof

Create `e2e/tests/dashboard-next/relay-inbound-caller-identity.spec.ts`.

- Use `createGroupOpen` from `e2e/fixtures/relayConnect.ts:158-185` after a lean
  reseed and post-reseed VA login. It returns an actual OPEN group and pool number
  even when a fresh number must first warm. Give the two members distinct
  per-run phone numbers; use a third, per-run E.164 for the external caller so it
  cannot be a member or contact.
- Place the call using `placeCall` from `e2e/fixtures/fakeVoice.ts:34-43`.
  Retrieve it with `listCalls`, then use existing `legPhones` from
  `e2e/fixtures/voiceSetup.ts:98-102` and assert `[]`; that is the control-plane
  proof that no `<Dial>` ran. `FakeCall` itself has only an index signature, so
  `legPhones` is the established typed test seam.
- Poll `GET /api/conversations/<id>/messages` in the authenticated `page.request`
  context until the row with `provider_sid === callSid` has
  `relay_refusal_reason === 'non_member'`, the normalized external phone, and no
  external contact ID. This gives causal API proof before UI navigation rather
  than relying on SSE timing.
- Navigate to `/conversations/<id>`. Scope UI checks to the `Communications and
  activity` region and a group named with the exact formatted-phone summary. Check
  `Not connected`, expand that card's Details control, and check phone,
  `No linked contact`, `Not a participant in this relay group`, and full
  date/time-with-seconds.
- Import the real dashboard formatter as
  `../../../dashboard/src/lib/phone.js`; cross-package source imports are already
  accepted by E2E (`e2e/tests/tour-roster.spec.ts:65`). Do not duplicate NANP
  formatting in the spec.
- Finish with an authenticated `GET /api/contacts?phone=<encoded external phone>`
  and assert `{ contacts: [] }`. This exact endpoint is already proven by
  `app/test/contactsCrud.test.ts:43-56` and browser specs such as
  `a2p-compliance.spec.ts:162-168`. In `afterAll`, restore the lean seed, matching
  the established full/lean restoration convention.

## Existing real-stack precedent

`e2e/tests/dashboard-next/voice-transcription.spec.ts:252-293` already proves a
real signed fake-Twilio pool-number call travels to the live relay Timeline and
asserts the masked no-recording invariant. The new focused proof should follow its
API-first polling and region-scoped UI style, but use a freshly created open group
instead of its full-profile seeded member call. That avoids accidental member
identity and directly proves the no-contact/no-Dial behavior in this feature.

## Drift / risk assessment

- No additional dashboard reader or mutator surfaced beyond the type ->
  `toTimelineMessage` -> `Timeline.CallCard` chain above.
- The plan's proposed E2E formatter import is viable, but the relative path from
  `e2e/tests/dashboard-next/` is `../../../dashboard/src/lib/phone.js`.
- Do not turn the absence of a contact ID into a contact creation, and do not use
  roster resolution for this case. The browser proof's empty-contact assertion is
  the durable regression tripwire.
- The new full-date formatter must be separate from the accessible-name formatter;
  changing the latter's invalid-value behavior would regress existing collision
  protections.
