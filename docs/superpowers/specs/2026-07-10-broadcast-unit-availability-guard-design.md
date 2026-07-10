# Broadcast unit-availability guard - design

**Date:** 2026-07-10
**Status:** approved (design discussion with Cameron, 2026-07-10)

## Problem

A broadcast with an attached property stamps a public flyer link
(`flyer_url = <publicBaseUrl>/p/<unitId>`) into every recipient's message. The
flyer backend only serves units whose status is `available`
(`SHAREABLE_STATUSES` in `app/src/lib/statusModel.ts`; the routes in
`app/src/routes/public.ts` return an opaque 404 otherwise). But nothing in the
broadcast pipeline checks the unit's status: create (`POST /api/broadcasts`),
preview, and send (`POST /api/broadcasts/:id/send` in
`app/src/routes/broadcasts.ts`) all accept a non-available unit. Result: staff
can broadcast a property whose flyer link is dead for every tenant who taps it.

The staleness case matters too: a draft created while the property was
Available can be sent days later after the status changed, so an entry-time
check alone is not sufficient - send time is the moment of truth.

## Decisions (made with Cameron)

1. **Block, no escape hatch.** If the property is not Available at send time,
   the send cannot proceed as-is. The dialog offers exactly two paths: flip
   the property to Available and send, or cancel. There is no "send anyway".
2. **Warn early AND gate at send.** A passive banner in the composer warns as
   soon as a non-available unit is attached; the blocking dialog fires on the
   Send click. The banner prevents wasted audience-curation work; the send
   check covers stale drafts.
3. **Server-side guard.** The send route rejects non-available units with a
   400 so raw API calls and future composer entry points (e.g. the planned
   Matching property typeahead) cannot ship a dead link. Draft create / edit /
   preview stay ungated - only the send is.

## Shared predicate

"Broadcastable" reuses the flyer's own gate: `unit.status === 'available'`.
Server-side, reuse the exported `SHAREABLE` set from
`app/src/lib/statusModel.ts` (re-exported as `SHAREABLE_STATUSES` in
`app/src/repos/unitsRepo.ts`) - do not write a second literal. Client-side the
dashboard already uses `unit.status === 'available'` for the flyer line
(`ListingDetail.tsx`, `flyerShareable`); the composer check uses the same
comparison on the loaded unit.

## UX

### Composer banner (passive)

`BroadcastComposer.tsx` already loads the attached unit (to pre-fill voucher
size + property label). When a unit is attached and `status !== 'available'`,
render a warning banner near the property label:

> This property is **<Status label>** - its flyer link won't work until it's
> Available. You'll be asked to make it Available when you send.

- Informational only; drafting, editing, and preview are not blocked.
- Uses the human status label (e.g. "On hold"), not the raw enum.
- No banner when no unit is attached (broadcasts without a property have no
  flyer link and are out of scope for this guard).

### Send-click dialog (blocking)

In `RecipientPreview.tsx`, the Send button's handler gains a pre-flight:

1. If the broadcast has a `unitId`, re-fetch the unit (fresh status - do not
   trust the object loaded when the composer opened).
2. If Available: send as today (no new UI).
3. If not: open a Modal (the repo's existing `Modal` + local-state confirm
   idiom, as in the "Delete draft?" confirm in `BroadcastsList.tsx`):

   > **Property isn't Available**
   >
   > The flyer link in this broadcast only works while the property is
   > Available. Its status is currently **<Status label>**.
   >
   > [ Make Available & send ]   [ Cancel ]

4. "Make Available & send" calls the existing status-transition API
   (`PATCH /api/units/:unitId/listing-status` with
   `{ toStatus: 'available', source: 'manual' }`, via the existing
   `setListingStatus` client wrapper), then proceeds with the normal send
   call. The flip goes through the single transition service, so the
   property's activity trail records the manual status change as usual.
5. "Cancel" closes the dialog; the draft is untouched.
6. If the flip succeeds but the send still returns `unit_not_available`
   (race: someone flipped it back), surface the error through the preview's
   existing send-error display; do not loop the dialog automatically.

## Server guard

`POST /api/broadcasts/:id/send` (`app/src/routes/broadcasts.ts`): after the
existing draft-state guard, if the broadcast has a `unitId`, load the unit and
reject unless `SHAREABLE_STATUSES.has(unit.status)`:

- Response: `400 { error: 'unit_not_available' }`.
- A missing/deleted unit at send time gets the same rejection (the link would
  be equally dead; no need for a distinct error).
- Create (`POST /api/broadcasts`) keeps its current behavior: unit must exist,
  any status accepted, `flyer_url` stamped. Preview unchanged.

## Out of scope

- No "send anyway" path (Decision 1).
- Broadcasts with no attached unit: untouched by all of this.
- Flyer links pasted manually into 1:1 conversation messages: not guarded.
- No new statuses, no changes to the status model or the flyer routes.

## Interaction with "Matching property sends" (parked branch)

The parked feat/matching-property-sends spec states "send endpoint unchanged";
this guard amends that. Consequences for that feature when it executes:

- Its 1:1 / seeded sends inherit the guard automatically (desired: never text
  a dead flyer link).
- Its composer Property typeahead attaches units in-composer; the banner logic
  keys off the composer's loaded unit + status, so the typeahead gets the same
  warning for free if it populates the same unit state.
- Merge note: both touch `BroadcastComposer.tsx` and
  `app/src/routes/broadcasts.ts`; expect small conflicts, resolve keeping both
  intents.

## Testing

Backend (`app/test/broadcastApi.test.ts` or a focused new file):
- Send with an attached non-available unit -> 400 `unit_not_available`,
  broadcast stays `draft`.
- Send with an available unit -> unchanged happy path.
- Send with no unit attached -> unchanged (no unit lookup rejection).
- Unit deleted between create and send -> 400 `unit_not_available`.

Dashboard component tests:
- `BroadcastComposer.test.tsx`: banner renders for a non-available attached
  unit (with the human status label); absent for available; absent when no
  unit.
- `RecipientPreview.test.tsx`: Send with non-available unit opens the dialog
  and does NOT call the send endpoint; "Make Available & send" calls
  `setListingStatus` then the send endpoint (in that order); Cancel calls
  neither; available unit sends with no dialog.

E2e (`e2e/tests/dashboard-next/broadcasts.spec.ts`):
- Extend or add a spec: from a NON-available seeded property, kebab ->
  compose -> Send -> dialog appears -> "Make Available & send" -> results
  page reached AND the property page now shows Available.
- Verify the seeded units used by the existing three broadcast describes are
  Available so they pass without modification (the API-driven "live send
  progress" spec now hits the server guard, so its seeded unit MUST be
  Available - check the seed and adjust the spec's unit choice if needed).

All four gates before declaring done: `npm run typecheck`, app + dashboard
suites, full `npm run e2e` (bare), plus live QA on the dev stack.
