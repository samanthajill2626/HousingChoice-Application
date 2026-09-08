# Self-QA - relay 30003 retry lineage (orchestrator-driven, hermetic lane)

Branch `feat/relay-30003-retry-lineage` @ `eda374a5` (after fix wave 3), lane 9
(`app :9901`, `dashboard :9911`, `fake :9921`, `E2E_RELAY_RETRY_BACKOFF_MS=10000`),
`npm run e2e:session`, dev-login as `va@example.com`, one relay group with two
CONTACTLESS members (Ada `+15558210041`, Bo `+15558210042`) driven to `open` on
pool `+14040190001`, intro settled on both. Measured, not eyeballed: visible
page text, the accessibility tree (accessible names), the fake's per-handset
thread store, `GET /api/conversations/:id/messages` payloads and
`GET /__dev/logtail`. Dates below are local (2026-09-03, 01:52-01:59).

## 1. Happy path - one leg fails 30003, retries to delivered (UI composer send)

Armed Ada; sent `Retry proof alpha 7731` from the composer.

- Fake store, Ada: `undelivered/30003` then `delivered`, BOTH legs with body
  `HousingChoice: Retry proof alpha 7731` (the composed leg copy, verbatim on
  the rung - D12). Bo: exactly ONE `delivered` leg (no duplicate send).
- Page text: original `delivered 2/2 - 1 on retry`; a second bubble with the
  same body reading `delivered 1/1 on retry` (D22).
- Accessible names: `img "delivered 2 of 2, 1 on retry. Ada Unreach:
  Delivered on retry, SMS, 1:52a. Bo Reach: Delivered, SMS,"` and
  `img "delivered 1 of 1 on retry. Ada Unreach: Delivered, SMS, 1:52a."`.
- Rows after clicking the original: list `Delivery by recipient` with
  `Ada Unreach - Delivered on retry - SMS - 1:52a` and `Bo Reach - Delivered -
  SMS`. All three positions agree (D21).
- Payload: retry row `2026-09-03T05:52:45.767Z#relayretry-a225b39f85e79506-1`
  (wall clock 1.36s after the root; SID `relayretry-<16 hex>-1`), `retry_of`
  ABSENT, `relay_retry_of` = the root, `relay_retry_member_key`
  `phone#+15558210041`, attempt 1, origin `outbound`, digest length 16,
  `relay_retry_leg_body` verbatim, `transport_schema_version: 1`, slot
  `planned -> attempted`, `sent -> delivered` with its own `sid`. The
  ORIGINAL's Ada slot still reads `undelivered/30003` (never rewritten - D1).
- Log: one WARN `event: delivery_failed, retryClaim: claimed, retryAttempt: 1`;
  no ERROR.

## 2. Retrying state, live

During a second send (`Cap ladder beta 4402`), 4s after the send: page text
`delivered 1/2 - 1 retrying - Phone unreachable (error 30003)`; accessible
name `img "delivered 1 of 2, 1 retrying, Phone unreachable (error 30003). Ada
Unreach: Retrying, Phone unreacha..."`. (The arming loop for this attempt
started late because tool calls run sequentially, so rung 1 delivered; the
message settled to `delivered 2/2 - 1 on retry` with its retry bubble.)

## 3. Ladder to cap - three rungs, terminal ERROR (API send, timed arming)

Sent `Cap ladder gamma 9915` via `POST /api/conversations/:id/messages`
with Ada armed, then re-armed at +5s, +15s, +25s.

- Fake store, Ada: FOUR outbound legs, all `undelivered/30003` (the original
  and three rungs). Bo: one `delivered`.
- Payload: three retry rows, attempts 1/2/3 at 05:56:16.495 / :26.837 /
  :37.174 (10.3s apart - the lane's 10s override), ALL with `relay_retry_of`
  = the root and one digest `dfabccd27862553c` (rungs chain to the ROOT, not
  to each other), `retry_of` absent; every Ada slot `undelivered/30003`.
- Log, in order: WARN `claimed` retryAttempt 1, WARN `claimed` 2, WARN
  `claimed` 3, then ERROR (level 50) `retryClaim: cap_exhausted`.
- Page, after the ladder: `delivered 1/2 - 1 failed - Phone unreachable
  (error 30003)` - today's exact cap-exhausted string (D19) - and NO
  `retrying` anywhere on the page: the ticker terminated (D18).

## 4. Inbound source - a member's message with the other member's leg armed

`POST <fake>/control/send-as-party` from Bo to the pool number, body
`Member note delta 6206`, Ada armed.

- Fake store, Ada: `undelivered/30003` then `delivered`, both legs
  `Bo Reach: Member note delta 6206` (member-originated leg copy, verbatim).
- Page: Bo's bubble renders ONCE, with NO chip (no `on retry`, no `img` in
  that bubble) and NO duplicate bubble - the inbound retry row is hidden (D20).
- Accessibility: `group "Delivery by recipient. Ada Unreach: Delivered on
  retry, SMS, 1:58a."` - the `inboundRecipientName` recital carries the state
  (spec Sec 2, the screen-reader surface).
- Payload: retry row `direction: inbound`, `author: unknown`,
  `relay_sender_key: phone#+15558210042`, origin `inbound`, NO message-level
  `requested_transport`, slot `requestedTransport: sms` (D2's distinction),
  Ada `delivered`.
- Log: WARN `claimed` retryAttempt 1.

## 5. Gate refusal - the group closed inside the backoff window

Sent `Closing epsilon 3311` with Ada armed; 3s later `PATCH
/api/conversations/:id/close {"closed":true}`.

- Log: ERROR `event: relay_retry_leg, retryClaim: gate_refused, closeCode:
  retry_group_closed, attempt: 1, memberKey: phone-only-member, msg:
  "relayRetryLeg: retry refused - relay group is not open"` (PII redacted).
- Payload: retry row slot `failed / retry_group_closed`, aggregation
  `excluded`; root slot `undelivered/30003`.
- Fake store, Ada: ONE leg for this token (`undelivered/30003`) - the retry
  never sent. Conversation `status: closed`, `last_activity_at` unchanged at
  the send time (no bump - D16).
- Page after a RELOAD: `img "delivered 1 of 2, 1 failed, Not retried, group
  closed. Ada Unreach: Undelivered, Not retried, group closed..."` - D15's
  prose at the chip and the recital.

**FINDING P1 (fixed in wave 4).** BEFORE the reload the live page still read
`delivered 1/2 - 1 retrying - Phone unreachable (error 30003)`: the job's
refusal wrote the retry row's slot but emitted no `message.persisted`, so no
client refetched. The same holds for every JOB-side terminal close
(`transient_cap`, and the `refused`/`filtered`/`suppressed` outcomes). Left
alone, a refused ladder reads `retrying` until any other SSE in any
conversation, then `not confirmed` after 15 minutes - never the refusal
reason the job wrote. D16's rationale for the claim-time SSE ("a false
terminal state ... on the surface this feature exists to make truthful")
applies word for word. The bus crosses processes (worker emits bridge to the
app's SSE - `app/src/lib/events.ts:250`, `app/src/worker.ts:45-47`) and
`app/src/jobs/voiceTranscript.ts` already emits `message.persisted` from a
job, so the fix is one emit per terminal close, for the ROOT, in
`relayRetryLeg.ts`. Adjudicated FIX (wave 4); re-verified live below.

**NOTE (pre-existing, not this feature's).** The conversation header kept
reading `Open` after the API close until the reload; the close route emits
no conversation-level SSE today.

## What was NOT exercised live

- D4's duplicate-DELIVERY marker (the lane cannot redeliver a job -
  research adjudication E6); unit-proven only.
- The tour and placement hosts (unit-pinned in T10).
- `enqueue_failed` and `transient_cap` (need a failing queue / a transient
  carrier code; unit-proven).

## Wave 4 re-verification (branch @ `80ddc1d2`, lane 11, 02:13 local)

Fresh session, fresh group (Cy `+15558210051`, Di `+15558210052`, pool
`+14040190001`, intro settled), the dashboard page OPEN on the conversation
before the send. Armed Cy; `POST .../messages` `Refusal zeta 5580`; 3s later
`PATCH .../close {"closed":true}`; 14s wait; page read with NO reload:

- Page text: `delivered 1/2 - 1 failed - Not retried - group closed`.
- Accessible name: `img "delivered 1 of 2, 1 failed, Not retried, group
  closed. Cy Unreach: Undelivered, Not retried, group c..."`.
- `retrying` appears nowhere on the page.
- Log: WARN `claimed`, then ERROR `event: relay_retry_leg, retryClaim:
  gate_refused, closeCode: retry_group_closed`. Conversation `status: closed`.

The job's terminal close now reaches the open page through the SSE the fix
emits. P1 closed.
