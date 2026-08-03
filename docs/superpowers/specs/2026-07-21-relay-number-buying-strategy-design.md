<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-03).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Relay Number Buying Strategy — A2P-safe warm pool

- **Date:** 2026-07-21
- **Status:** design (approved in brainstorming; pending spec review)
- **Extends:** [2026-07-17-relay-number-lifecycle-design.md](2026-07-17-relay-number-lifecycle-design.md) (burn multiplexing + 180-day retirement)
- **Related:** [a2p-compliance-hardening](../../issues/a2p-compliance-hardening.md), the delivery-failure severity taxonomy (2026-07-21, `routes/webhooks/twilio.ts`)

## Problem

Relay groups buy a fresh Twilio number at group-creation time and send the intro
within ~1 second. A freshly-bought number is **not attached** to our A2P 10DLC
Messaging Service / campaign, so US carriers reject every send with **error 30034**
("message from an unregistered number").

Confirmed live on dev: a tour "Open group text" delivered **0/2** — both intro legs
came back `undelivered` / `30034`. Manually attaching that number to the already-
approved campaign made it deliver within **~2 minutes**.

Root cause (both confirmed absent in current code):
1. No code path attaches a purchased pool number to the Messaging Service sender pool.
2. No code path confirms a number's A2P registration before using it to send.

Today this is fenced off by `RELAY_LIVE_PROVISIONING=false` pre-A2P; the gap is a
documented manual/RUNBOOK step. This design closes it in code.

## Goal

Relay group texts deliver reliably under A2P 10DLC, with **no staff-visible send
failures**, by never sending from a number until it is carrier-registered — while
preserving the existing burn-multiplexing model and staying well under the
400-number Messaging Service cap.

## Key facts / constraints (from research)

- **A2P registration is not instant.** Attaching a number to the campaign-linked
  Messaging Service enrols it, but it transitions `PENDING_REGISTRATION →
  REGISTERED` asynchronously. Twilio publishes no SLA ("several days" worst case;
  ~2 min observed against an already-approved campaign). **Buy-and-send-immediately
  cannot work.**
- **Sender-pool cap = 400 numbers** (Standard campaign). A non-issue given
  multiplexing keeps the working set small; retirement frees slots.
- **A Twilio-to-Twilio canary is not a reliable delivery test.** The A2P
  registration check is enforced at US carrier gateways; a message from one Twilio
  number to another may route on-net and bypass that gateway, so a `delivered` DLR
  could be a false positive. **Canary rejected** — see §2.

## Design overview

Maintain a small buffer of **pre-registered, un-burned "fresh spare" numbers**.
Group creation draws from existing multiplexed numbers first, then a fresh spare,
and only falls back to buy-and-wait when both miss. A background **readiness gate**
guarantees no number is ever used before it is carrier-registered.

### 1. Pool-number lifecycle — new `warming` state

Add one state to the existing `active → releasing → released` machine:

- **`warming`** — purchased and attached to the Messaging Service, awaiting
  `REGISTERED` confirmation. **Invisible** to the reuse loop and to the spare count;
  not usable by any group.
- **`active`** — registration-confirmed; usable. An `active` number with an **empty
  `burned_phones`** set is a **"fresh spare."**
- **`releasing` / `released`** — unchanged (180-day retirement).

`warming → active` happens only after the readiness gate (§2) passes. The existing
`byLifecycleState` GSI auto-partitions the new state value; no new GSI is required.
Add `warming_started_at` (stuck-detection clock) and optionally a cached
`registration_status`.

### 2. Readiness gate — Event Streams, never send from an unregistered number

A `warming` number is promoted to `active` only after **both**:

1. **Attached** to the Messaging Service sender pool — new adapter method
   `client.messaging.v1.services(sid).phoneNumbers.create({ phoneNumberSid })` (takes
   the `PN...` SID, not the E.164). This is the missing step behind the 30034.
2. **Twilio confirms A2P registration finished** via an **Event Streams** event
   `com.twilio.messaging.compliance.number-registration.successful`, correlated to our
   number by `messaging_service_sid` + the phone number in the payload.

**Why Event Streams, not polling.** Twilio exposes **no REST field** to poll a
per-number `PENDING_REGISTRATION -> REGISTERED` state (verified 2026-07-21): campaign
status (`usAppToPerson.campaignStatus`) is aggregate and stays `VERIFIED` while an
individual just-added number is still registering. The per-number completion signal
lives only in the Console and in **Event Streams**. Subscribing to it means a number
is **never used before it is confirmed registered**, which also protects our A2P
**trust score** — repeated unregistered sends (30034) lower the score and throttle
throughput, so emitting zero of them is a feature, not just hygiene.

**Event Streams wiring** (webhook sink is **free**; Kinesis is the only paid sink):
- A per-env **Sink** (`webhook`) -> new app endpoint `POST /webhooks/twilio/events`.
- A **Subscription** to the compliance number-registration event types.
- The endpoint validates the event, finds the matching `warming` pool record, and
  promotes it `warming -> active` (and, for a tier-3 connecting group, drives the
  group open + intro + queued flush -- 4/5). De-registration events can later inform
  retirement.

**Bounded warming (stuck detection).** `warming_started_at` + a threshold
(`RELAY_WARMING_MAX_WAIT`): a number still `warming` past the window raises an error /
attention item (stuck-registration) for ops. This timer is for **alerting only**,
never for promotion -- promotion is strictly the Event Streams confirmation.

### 3. Warm buffer + refill

- **Buffer target `K` fresh spares:** **dev 0, prod 2.** (dev 0 forces every
  new-number need through tier 3 — the connect-when-ready test path.)
- **Buffer count = fresh-active spares + still-`warming` numbers** — the debounce:
  we never buy a second spare while the first is still registering.
- **Refill trigger: event-driven.** After every relay-group creation, recompute the
  buffer count; if `< K`, enqueue warm job(s) to reach `K`. Nothing proactive/cron.
  Plus a manual admin action (**"warm N numbers"**) for cold-start and ops control.
- **Warm job:** `adapter.provisionPhoneNumber` → create `warming` record → attach →
  poll `REGISTERED` → `active`. Gated by `RELAY_LIVE_PROVISIONING` (existing; off
  pre-A2P, so this whole path stays dormant until the operator flips it on).

### 4. Group creation — three tiers

`provisionForGroup(roster)` resolves a number in order:

1. **Reuse** — an `active` number un-burned for the whole roster, **preferring
   numbers that already carry burns** (true multiplexing; preserves fresh spares).
   Atomic burn-claim, as today.
2. **Fresh spare** — consume an `active`, empty-burn spare (works for *any* pair by
   construction; burn-claim the roster onto it).
3. **Connect-when-ready** — reuse missed *and* no spare available. Create the relay
   group in a **`connecting`** state; enqueue a warm job to buy+register a dedicated
   number; on ready, assign it, transition the group to `open`, **auto-send the
   intro, then flush any queued messages in order** (§5).

After any tier, run the refill calc (§3).

### 5. Connecting groups + queued ("fire-and-forget") messages

- A `connecting` relay group has no number yet and **cannot send/receive** until
  ready; the UI surfaces the *connecting…* state plainly.
- Staff may compose message(s) on a connecting group; they are **queued** (persisted,
  not sent), never lost.
- When the number becomes ready: group → `open`; send the auto-intro (`relay.intro`);
  then flush the queued messages **in creation order** via the now-live number.
- **Escalation:** a group still `connecting` past a threshold raises an attention
  item / error (stuck-connecting), so staff are never left waiting silently.

### 6. Retirement — explicit Messaging Service detach

On release (`retireEligible → releaseNumber`), **explicitly detach** the number from
the Messaging Service sender pool alongside the Twilio number delete (today it is
implicit-on-delete). Keeps the sender pool accurate and frees a slot against the 400
cap. The 180-day retirement window and grace logic are otherwise unchanged.

### 7. Observability

- Warming failures, stuck-registration, and stuck-connecting log at `error` (feed
  Recent Errors + the alarm), reusing the delivery-failure taxonomy conventions.
- Any real 30034 that still slips through is already a terminal delivery error and
  surfaces on the Recent Errors panel + alarm — a backstop, though the Event Streams
  gate should mean we never emit one in the normal flow.
- The existing pool-numbers admin inventory surfaces warming / active / spare counts.

## Config

- `RELAY_SPARE_BUFFER_TARGET` — per env: **dev 0, prod 2.**
- `RELAY_WARMING_MAX_WAIT` — stuck-registration ALERT window (never used for promotion).
- `TWILIO_EVENTS_WEBHOOK_PATH` / sink URL — the Event Streams webhook endpoint per env.
- `RELAY_LIVE_PROVISIONING` — **existing**; gates all number buying (off pre-A2P).
- No canary destination needed (canary dropped).

## Data model changes

- `PoolNumberItem.lifecycle_state` gains `'warming'`; add `warming_started_at`. No new
  GSI. Correlate the Event Streams event to the record by phone number (the record PK).
- Relay-group conversation: a `connecting` status + a queued-message store (reuse the
  scheduled-message machinery, or persist messages in a `queued_pending` state — TBD
  in planning).

## Seams touched

- `adapters/messaging.ts` — **+** `attachToMessagingService(phoneNumberSid)`.
  (`provisionPhoneNumber` / `releasePhoneNumber` already exist. No status-read method —
  registration is confirmed by the Event Streams webhook, not a poll.)
- **New webhook:** `routes/webhooks/twilioEvents.ts` (or extend the twilio webhook
  router) — `POST /webhooks/twilio/events`, validates the Event Streams event and
  promotes `warming -> active`.
- **Infra:** Terraform for the Event Streams **Sink (webhook)** + **Subscription** to
  the compliance number-registration events, per env, pointing at the app endpoint.
- `services/poolNumbers.ts` — 3-tier `provisionForGroup`; warm job; refill calc;
  exclude `warming` from `listActive` / burn-claim.
- `repos/poolNumbersRepo.ts` — `warming` state writes; promote-on-event; fresh-spare +
  warming counts.
- `jobs/` — warm/refill job(s); connect-when-ready orchestration; queued-message flush.
- `services/relayProvisioning.ts` + routes (`tours`, `placements`, `relayGroups`) —
  connecting-group creation path.
- Retirement (`retireEligible` / `releasePhoneNumber`) — detach from Messaging Service.
- `dashboard/` — connecting-group UI + queued composer; pool-admin warming counts.

## Non-goals

- No autoscaling beyond the fixed `K` buffer.
- No real-mobile canary (revisit **only** if a `REGISTERED`-but-undelivered case is
  ever observed via the errors panel).
- No change to the burn-multiplexing invariant or the 180-day retirement window.
- No scheduled cron — event-driven refill + manual admin action only.

## Open questions (resolve during planning, not blockers)

- **Event Streams payload schema + webhook auth** — confirm the exact field carrying
  the phone number / `PN` SID in the `number-registration.successful` v2 payload, and
  how an Event Streams webhook sink authenticates its POSTs (it is NOT the classic
  `X-Twilio-Signature` request flow). A short spike against a live event or the Event
  Streams schema registry, as Task 1 of the plan.
- Queued-message storage model: reuse scheduled-message machinery vs. a new
  `queued_pending` message state.
- Whether `connecting` should be a new `relay_status` value or a flag alongside it.
- Whether the Event Streams Sink/Subscription is created via Terraform or a one-time
  provisioning script (Event Streams config is account-scoped; needs per-env sink URLs).
