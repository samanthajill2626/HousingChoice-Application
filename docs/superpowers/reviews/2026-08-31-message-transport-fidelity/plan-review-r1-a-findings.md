# Plan review r1 A - message transport fidelity

Verdict: FAIL - do not launch implementation until the two HIGH findings are
resolved.

Counts: BLOCKING 0, HIGH 2, MEDIUM 1, LOW 0.

## 1. [HIGH] Status-callback normalization is ordered before the request context it requires

What is wrong:

The plan tells the webhook to normalize provider evidence at the top of the
handler and pass only normalized output downstream. Its own normalizer interface
requires `requestedTransport`, and the approved fallback rule requires that
context to decide whether an outbound `SM`/`MM` SID plus non-channel `From` is
RCS fallback evidence. At the top of the current callback handler neither the
direct message nor the relay SID pointer/recipient slot has been resolved, so no
requested transport is available. Normalizing there turns the required RCS
fallback observation into missing or an unconditional SMS/MMS observation. The
plan's later fallback tests cannot be satisfied by the stated implementation
ordering.

Evidence:

- The plan's `TwilioTransportEvidenceInput` includes `requestedTransport`
  (plan section 1, lines 232-241), and its precedence tests require an RCS
  request before interpreting `SM`/`MM` as fallback (lines 284-287).
- The plan directs the implementation to construct normalizer input "at the top"
  of authenticated webhook handlers and pass only normalized output downstream
  (Task 4.4, lines 644-648), while requiring RCS-to-SMS fallback tests in the
  same task (lines 621-627).
- The approved spec permits `SM`/`MM` fallback evidence only for an
  RCS-requested message with a non-channel `From` (spec section 4.1,
  lines 149-153).
- Current status handling first resolves the direct message or relay SID pointer
  after reading `MessageSid` (`app/src/routes/webhooks/twilio.ts:2406-2434`);
  relay requested transport is necessarily on the source recipient slot, not the
  status-callback envelope (`app/src/routes/webhooks/twilio.ts:2348-2366`).

Remedy:

Resolve the message or relay pointer/slot first, then invoke the provider-boundary
normalizer with that resolved requested transport before applying actual evidence.
Keep raw Twilio fields confined to that normalization call. Add direct and relay
callback tests where RCS-requested plus E.164 `From` and `SM`/`MM` records the
fallback, while the identical callback with no RCS request remains missing or
conflicting per the approved precedence.

## 2. [HIGH] The seed plan omits the full-profile cast message corpus

What is wrong:

The plan says every seeded carrier message must declare versioned transport and
lists the lean, live, matrix, and performance seed modules, but it omits
`seed/cast.ts`. The full seed profile directly merges `castItems()` and that file
contains a large set of SMS/MMS message items. Following the listed Task 8 files
and tests leaves those carrier rows schema-absent, contradicting the approved
requirement that ordinary full/lean seed rows carry explicit fake-provider
transport facts. This is not an import-history exception.

Evidence:

- The approved spec requires lean/full and generated performance carrier rows to
  be version 1 with explicit normalized actual transport (spec section 11,
  lines 733-746).
- Task 8 lists `lean.ts`, `live.ts`, `matrix.ts`, and `performance.ts`, but not
  `cast.ts` (plan lines 944-956); its stated contract requires every seeded
  carrier message to use the helper (lines 992-1008).
- The full profile merges `castItems()` into the persisted seed tables
  (`app/src/lib/seed/index.ts:125-132`). `app/src/lib/seed/cast.ts:144-155` is
  one direct inbound SMS item, and the file contains further SMS/MMS message
  declarations (for example `app/src/lib/seed/cast.ts:1216-1227`).

Remedy:

Add `app/src/lib/seed/cast.ts` and its full-profile expectations to Task 8's
owned files and red/green tests. Route every cast carrier item through the same
explicit declaration helper, preserving deliberately legacy fixtures only where
the plan names and tests that exception.

## 3. [MEDIUM] The central result-patch interface names a nonexistent status type

What is wrong:

The persistence contract declares `RecipientSendResultPatch.status` as
`RelayRecipientStatus`, but that type does not exist in the current repository.
The live recipient slot uses `DeliveryStatus`. This leaves the central
`applyRecipientSendResult` interface non-compilable as written and obscures
whether it must support the current `queued_pending` value and existing
forward-status rules.

Evidence:

- Task 3 declares `status: RelayRecipientStatus` in
  `RecipientSendResultPatch` (plan lines 487-493).
- The current slot model is `RelayRecipientDelivery.status: DeliveryStatus`
  (`app/src/repos/messagesRepo.ts:156-163`), and no `RelayRecipientStatus` is
  defined under `app/src` or `dashboard/src`.
- The plan explicitly requires an accepted provider result mapped to already
  `queued` slots without status regression (plan lines 523-532), which depends
  on the actual shared status union.

Remedy:

Specify `DeliveryStatus` (or introduce and fully define an intentionally narrower
shared alias) in the plan, state which existing values are legal for a producer
result, and pin the forward-transition behavior in the repository contract tests.
