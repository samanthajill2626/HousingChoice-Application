# Phase 6 spec-conformance review - PASS

Reviewed final candidate `834f8a52948a02139300f4b8fac8b9ec1e1ad1e3` against the
approved design spec, the S1-S5/E1 work map, and the complete `main...HEAD`
diff. This is a read-only code review; only this durable review report changed.
`git diff --check main...HEAD` returned exit 0.

## Findings

No remaining must-fix findings. PASS.

The two previous P2 findings are fixed. The issue record now uses the supported
`resolved` status, carries a `resolved: 2026-08-28` stamp, and has a dated
resolution ([e2e-typecheck-masks-ts6142.md](../../docs/issues/e2e-typecheck-masks-ts6142.md):1-25).
The handback now describes the branch-caused import graph, records passing root
and E2E workspace typechecks, distinguishes the code and documentation
correction commits, and names `834f8a52` as the merge-ready candidate
([handback.md](../sdd/handback.md):32-38, 70-72, 93-104).

The code remediation remains narrow and correct: the formatter imports only
values/types from the pure `dashboard/src/api/types.ts` module, so the E2E
assertion does not transitively load the JSX API barrel
([format.ts](../../dashboard/src/routes/contact/format.ts):1-10).

## Spec conformance evidence

- Durable-shape enforcement is centralized at the append boundary. It admits the
  three fields only for an inbound, masked call with the exact `non_member`
  reason, unknown author, no sender key, a valid E.164 phone, and a phone for
  every contact ID ([messagesRepo.ts](../../app/src/repos/messagesRepo.ts):825-844,
  1901-1963). The focused repository cases exercise all rejected shapes before a
  DynamoDB write ([repos.test.ts](../../app/test/repos.test.ts):168-303).
- The webhook adds metadata only after the existing refusal reason has been
  computed, and only for `non_member`: it normalizes `From`, makes one
  deletion-fenced best-effort lookup, and preserves phone-only persistence when
  that lookup fails ([voice.ts](../../app/src/routes/webhooks/voice.ts):900-963).
  The existing member bridge begins after that untouched refusal arm
  ([voice.ts](../../app/src/routes/webhooks/voice.ts):966-1060); no route or
  resolver change appears in `main...HEAD`.
- The refusal retains its masked Say/Hangup response, emits no Dial, and neither
  modifies a contact nor changes relay membership. The signed-webhook cases
  cover matched, unmatched, deleted, malformed, failed-lookup, and redelivery
  calls ([voiceWebhook.test.ts](../../app/test/voiceWebhook.test.ts):422-600).
- Page-local authenticated hydration deduplicates stored IDs, batch-reads the
  restricted display projection (including `deleted_at`), omits missing/deleted
  records, does not mutate stored rows, and returns the original page on batch
  failure ([api.ts](../../app/src/routes/api.ts):2121-2168;
  [contactsRepo.ts](../../app/src/repos/contactsRepo.ts):856-864,
  1072-1078; [conversationHubApi.test.ts](../../app/test/conversationHubApi.test.ts):317-406).
  There is no read-time phone lookup.
- The Relay mapper forwards only the newly approved staff fields and continues
  dropping recording, transcript, provider-ID, and media data
  ([useRelayThread.ts](../../dashboard/src/routes/conversation/useRelayThread.ts):57-104).
- The pure presenter gates on the exact refusal reason, uses hydrated name then
  formatted stored phone then unknown caller, and never consults the current
  roster ([presentRelayExternalCaller.ts](../../dashboard/src/routes/contact/presentRelayExternalCaller.ts):10-40).
  `Not connected` similarly requires that exact machine reason, leaving every
  ordinary call on the prior state path ([presentCallState.ts](../../dashboard/src/routes/contact/presentCallState.ts):107-125).
- The card keeps the plain-text primary line, minute face clock, card-specific
  accessible name/control, collapsed Details, and revealed D3 facts including
  a visible full local seconds timestamp or `Time unavailable`
  ([Timeline.tsx](../../dashboard/src/routes/contact/Timeline.tsx):1210-1335;
  [format.ts](../../dashboard/src/routes/contact/format.ts):57-68). The UI
  tests cover named, number, unavailable, stale/deleted, roster-collision, and
  same-minute states ([Timeline.test.tsx](../../dashboard/src/routes/contact/Timeline.test.tsx):2165-2335).
- The hermetic E2E path drives a real fake non-member inbound call and verifies
  persistence, zero Dial legs, no contact creation, staff face/chip, and
  expanded details ([relay-inbound-caller-identity.spec.ts](../../e2e/tests/dashboard-next/relay-inbound-caller-identity.spec.ts):48-116).

## Attacked but not broken

- A current contact whose name is blank correctly falls back to the stored phone
  and `No linked contact`: the approved D3 contract makes `View contact`
  conditional on a non-deleted *display name*, not merely an ID.
- Closed-thread, no-callee, and no-pool-number refusal rows cannot acquire the
  fields because only `reason === 'non_member'` spreads them; the closed and
  other refusal tests assert their absence.
- A redelivery can repeat the lookup but cannot rewrite history: `append` remains
  CallSid-idempotent and the test proves the original stored ID remains after a
  later deletion.
- A newly matching contact cannot reinterpret an unmatched historical row: the
  API collects IDs only, and the card performs no phone/roster lookup.
- A corrupted external-caller field cannot alter an ordinary card: the mapper
  requires the exact reason and the UI presenter is reason-gated.
- Phone disclosure remains staff-only in the changed flow: it is not passed into
  TwiML, Dial caller ID, whispers, events, or notifications; the refusal tests
  assert no Dial and phone-free TwiML.

## Verification note

I did not re-run feature gates in this review turn. The handback records post-sync
successful `npm test`, smoke, and hermetic E2E gates, plus the documented
main-line e2e-typecheck baseline and no branch-attributable touched-file lint
finding. This conformance verdict is based on the final tree and those recorded
results, not a new execution claim.
