# Inbound-Message Push Notifications - Design Spec

Date: 2026-08-16
Branch: feat/inbound-message-push (worktree W:\tmp\inbound-message-push, cut
from main @d0c28678)
Origin issue: docs/issues/no-push-on-inbound-message.md

## 1. Problem

Push notifications exist only for voice today. The four pushService send
sites are: test (routes/push.ts), pre_ring / missed_call / voicemail
(routes/webhooks/voice.ts). An inbound text or email produces NO push at
all. Staff who install the PWA expect the app to behave like a native
messaging app: a new inbound message should raise a notification that
deep-links to the thread.

## 2. Settled product decisions (operator, 2026-08-16 - DO NOT REOPEN)

Recorded in docs/issues/no-push-on-inbound-message.md and the brainstorm:

- D1 Recipients: EVERYONE with an active push subscription. No owner or
  assignment filtering. Opting out = turning notifications off on the
  device/PWA.
- D2 Volume: native-messaging-app semantics. Per-conversation coalescing
  via the notification tag only; NO additional server-side throttle.
- D3 Quiet hours: device do-not-disturb ONLY. Org quiet hours are
  outbound-only and must NOT gate staff-facing pushes.
- D4 Content: full sender + message content in the push, like a native
  SMS app. Lock-screen privacy is the device's job.
- D5 Scope: "message" = any inbound message channel - SMS/MMS and email.
- D6 Unmatched email: pushes too, deep-linking to the /email triage page
  (requires a small service-worker route-allowlist extension - the one
  client-side change in this feature). Only fresh status 'unmatched' rows
  push; quarantined / virus / spam / dismissed rows never push.
- D7 Reingest: when staff click "Link to contact" and the ingest re-runs
  with the reingest flag, NO push is emitted (old mail being filed, and
  the acting staff member is looking at it).
- D8 Copy: push titles/bodies are inline literals at the send site,
  matching the four existing push sends. Push copy is staff-facing and
  deliberately outside the contact-facing message catalog.

Planner-settled technical decisions:

- D9 TTL: none (web-push default). Message pushes are late-better-than-
  never, exactly like missed_call and voicemail. Pinned by test.
- D10 Enumeration: recipients come from usersRepo.listAll() (the accepted
  tiny-table scan pattern; listByRole is listAll + filter already).
  Everyone means admin AND va roles - all users.
- D11 Emission is fire-and-forget (void promise + .catch log) at every
  site: a push must never delay or fail a webhook ack or the email
  ingest. This copies the pre_ring pattern (voice.ts:623-633).

## 3. What gets built

### 3.1 pushService.sendToAll (app/src/services/pushService.ts)

New method on the existing PushService interface:

    sendToAll(notification: PushNotification): Promise<SendToAllResult>

Behavior:

- If push is unconfigured (VAPID unset): ONE info/warn log line and a
  zeroed result. It must NOT log once per user (an unconfigured local/e2e
  stack ingests many messages; per-user warns would be noise).
- Otherwise: usersRepo.listAll(), then for each user call the existing
  per-user send path (same semantics as sendToUser: per-device loop,
  allowlist prune, Gone prune, transient keep). Per-USER try/catch so one
  failing user never aborts the fan-out - the same isolation shape as the
  voice founder loop (voice.ts:1858-1864).
- If listAll() itself throws: log error, return zeroed result - never
  throw (mirrors resolveFounders, voice.ts:716-724).
- Result aggregates the per-user tallies: { configured, users, attempted,
  sent, pruned, failed }.
- PII posture unchanged: log kind + counts only, never the payload.

Voice sends are NOT migrated to sendToAll in this feature (no behavior
change to pre_ring/missed_call/voicemail; their recipient semantics are
holder/admin-only and out of scope).

### 3.2 Emit sites - SMS/MMS (app/src/routes/webhooks/twilio.ts)

The invariant: EVERY fresh inbound message append emits exactly ONE push
fan-out; a deduped redelivery, an echo drop, a reingest, or a non-
unmatched email quarantine emits NONE.

There are exactly four inbound message append sites in twilio.ts; each
gets one push emission, placed in its existing fresh-append block (the
same block that does incrementUnread + SSE emits, which is already gated
on !appended.deduped):

| # | Path | Append site | Emit near | conversationId |
|---|------|-------------|-----------|----------------|
| 1 | Plain 1:1 SMS/MMS | :1975 | :2134-2146 (fresh-append block) | persistedConversationId |
| 2 | Relay-group inbound | :485 | :610-618 | relay.conversationId |
| 3 | Closed-group intercept | :848 | :917-925 | sender's 1:1 conversationId |
| 4 | Native group text | :1570 | :1672-1680 | thread.conversationId |

(Line numbers are anchors as of main @d0c28678; the plan re-anchors.)

Notes:

- Keyword messages (STOP/HELP/etc.) ARE pushed when they are persisted as
  inbound messages - native SMS shows them; the rule is "persisted fresh
  inbound message row => push". Echo drops never persist, so never push.
- Twilio webhook retries hit the dedupe path (appended.deduped) and must
  not re-push. Placing the emit inside the existing fresh-append blocks
  gives this for free; tests pin it.
- The wiring: TwilioWebhookDeps gains an optional pushService (defaulted
  like voice.ts:309-310). WebhooksRouterDeps already carries pushService
  through the intersection type (webhooks/index.ts:16-19).

### 3.3 Emit sites - email (app/src/services/inboundEmail.ts)

Two sites:

- MATCHED (threaded) email: inside thread(), after the fresh append and
  alongside the existing SSE emits (:719-727). The append there is also
  dedupe-gated (rfc-id dedupe happens earlier), so a redelivered notice
  never re-pushes. SKIPPED when the reingest flag is set (D7).
- UNMATCHED email: in quarantineRow, ONLY when status === 'unmatched'
  (the same condition that emits the unmatched_email.updated SSE for
  fresh rows). Quarantined / dismissed rows never push (D6). Reingest
  never reaches this path with a fresh row, but the reingest guard
  applies here too for symmetry.

Wiring: InboundEmailDeps gains an optional pushService. Construction
points that must supply it (or accept the default):

- app/src/worker.ts (PROD email path): the worker constructs NO push
  machinery today. It gains createUsersRepo + createPushService and
  passes pushService into ingestDeps (worker.ts:209-220). pushService is
  cheap to construct and no-ops when VAPID is unset.
- routes/webhooks/ses.ts (dev/e2e inbound route): its ingest deps gain
  pushService the same way.
- routes/unmatchedEmail.ts (reingest): supplies pushService too, but the
  reingest flag suppresses emission (D7). This keeps the deps uniform
  and the guard in ONE place (the service), not in each caller.

### 3.4 Payload shapes (flat, matching the voice sends)

All payloads are FLAT top-level fields (title, body, kind,
conversationId, ...) - the service worker reads kind/ids at the JSON
root. NEVER nest under data (the /api/push/test payload nests and its
kind is silently dropped; do not copy it).

kind 'message' (has a conversationId; tag becomes message:<convId>):

| Path | title | body |
|------|-------|------|
| 1:1 SMS (+ closed-group intercept) | contact display name, else the conversation's participant_display_name, else formatPhoneForDisplay(From) | Body text; media-only: "Sent an attachment." |
| Relay-group inbound | the relay thread label (same label the inbox shows) | "<sender name>: <Body>"; media-only: "<sender name> sent an attachment." |
| Native group text | groupThreadLabel(thread.participants) (the canonical inbox/header title) | "<sender first name or phone>: <Body>"; media-only: sender + " sent an attachment." |
| Matched email | contact display name, else parsed from-name, else the from address | subject; if subject is empty, the body-text snippet |

kind 'unmatched_email' (no conversationId):

| title | body | extra field |
|-------|------|-------------|
| parsed from-name, else the from address | subject, else the stored snippet | unmatchedId (for the notification tag ONLY) |

Rules:

- Sender-name derivation reuses what each path already has in scope (the
  research map): contact lookups already happen at every persist point;
  no new lookups are added on the hot path.
- Closed-group intercept renders as a plain 1:1 message (it files into
  the sender's 1:1). No "(via group)" suffix in v1.
- Body is the full message text (D4); the push service already never
  logs payloads. No truncation beyond what the sources already cap
  (email subject/snippet are capped at ingest; SMS bodies are
  carrier-bounded). The plan may add a defensive cap (e.g. 500 chars)
  only if the reviewer demands one - FCM's 4KB payload limit is the
  real bound.

### 3.5 Client change (the ONE dashboard change): kind 'unmatched_email'

Tested-mirror pattern (dashboard/src/sw/display.ts + route.ts are the
tested source of truth; dashboard/public/sw.js carries verbatim copies -
BOTH must be updated, and the mirrors stay in sync):

- display.ts notificationTag: the tag id preference becomes
  callId || conversationId || unmatchedId. An unmatched push gets tag
  unmatched_email:<unmatchedId> - one notification per unmatched email
  (native mail behavior), coalescing only exact redeliveries.
- display.ts PushDisplayData gains optional unmatchedId. The
  notification data allowlist (C1) is UNCHANGED - data still carries
  only {kind, callId, conversationId}; routing does not need
  unmatchedId, only the tag does.
- kind 'unmatched_email' is NOT time-sensitive (no requireInteraction,
  no renotify), same as 'message'.
- route.ts resolveSafePath: a payload with kind 'unmatched_email' (and
  no plausible conversationId) resolves to '/email'.
- route.ts assertSameOriginPath allowlist adds exact-match '/email'
  (NOT a prefix - /email/quarantine is not a push target).
- display.test.ts + route.test.ts pin all of the above; sw.js mirrors
  are updated verbatim with the existing mirror-banner discipline.

kind 'message' requires NO client change: the SW already displays it,
tags it message:<conversationId>, and deep-links taps to
/conversations/<id>.

### 3.6 Copy (D8)

Inline literals at the send sites. New strings introduced (staff-facing,
ASCII): "Sent an attachment." and the sender-prefixed variants above.
No catalog entries, no new channel in MessageDef.

## 4. Non-goals (explicit)

- No per-user or per-conversation notification preferences / mutes (none
  exist in the data model; D1 says everyone).
- No server-side quiet hours, rate limiting, digesting, or batching (D2,
  D3).
- No change to the voice push sends (pre_ring/missed_call/voicemail
  recipient semantics, TTLs, and payloads stay byte-identical).
- No migration of routes/push.ts test payload's nested-data quirk (filed
  separately if desired; out of scope).
- No pushsubscriptionchange handler (already filed:
  docs/issues/push-subscription-change-not-handled.md).
- No e2e push seam (fake push endpoint / dev outbox for pushes). The
  voice pushes shipped with unit-harness coverage only; this feature
  follows that precedent. A follow-up issue files the seam idea.
- No badge/unread-count integration, no notification actions on message
  pushes in v1.

## 5. Volume and scale analysis (exact numbers)

- Team size: users table is invite-only and tiny (prod today: 2 admins;
  seed: 1 admin + 1 va). MAX_PUSH_SUBSCRIPTIONS = 10 per user. Worst
  case fan-out per inbound message: users x devices, realistically
  2 x ~2 = ~4 POSTs, hard-bounded by 10 per user.
- Group fan-in is safe by construction: ONE inbound group/relay message
  produces ONE message row (relay fan-out sends provider SMS, never new
  rows), so the 132 imported group threads multiply nothing. Each
  inbound message = one push fan-out, coalesced client-side per
  conversation tag.
- listAll() is a scan of the tiny users table - the identical accepted
  pattern the missed-call push already uses on the call path
  (voice.ts:710-724 doc comment).
- The sends are serial per user/device and fire-and-forget off the
  request path (D11), so webhook latency is unaffected.

## 6. Testing strategy

Unit (app):

- pushService.sendToAll: fan-out across users, per-user failure
  isolation, listAll-throw safety, unconfigured single-log no-op,
  aggregate tally, TTL absence (adapter receives undefined options -
  pins D9), PII (payload never logged).
- twilioWebhookHarness (world.pushSends) per path: 1:1 SMS pushes with
  contact-name title; MMS media-only body; relay push with thread label
  + sender-prefixed body; closed-group intercept pushes as 1:1; native
  group push with groupThreadLabel title; webhook REDELIVERY (dedupe)
  pushes nothing; echo drop pushes nothing; keyword STOP still pushes.
  All existing voice push tests stay green (no recipient/payload drift).
- inboundEmail tests: matched email pushes (title/body rules); rfc-id
  redelivery pushes nothing; unmatched pushes kind 'unmatched_email'
  with unmatchedId; quarantined/virus/spam/dismissed push nothing;
  reingest pushes nothing (both matched and unmatched branches).
- Worker wiring: worker constructs pushService and threads it into
  ingest deps (shape-level test if the worker has a harness; otherwise
  typecheck + a construction unit test).

Unit (dashboard):

- display.test.ts: unmatched_email tag = unmatched_email:<unmatchedId>;
  tag id preference order callId > conversationId > unmatchedId; not
  time-sensitive; data allowlist still excludes unmatchedId.
- route.test.ts: kind unmatched_email resolves to '/email';
  assertSameOriginPath allows exact '/email' and still rejects
  '/email/quarantine' and everything else; conversationId payloads
  still win and route to /conversations/<id>.

e2e:

- Full suite green (no push seam exists; no new e2e spec for push
  display - see Non-goals). Inbound-message e2e specs must not break:
  push emission is fire-and-forget and no-ops without VAPID, so the
  hermetic lane sees at most one quiet log line.

## 7. Invariant surface enumeration (mutation + reader sweep)

Invariant: "every fresh inbound message append emits exactly one push
fan-out; dedupe/echo/reingest/quarantine-not-unmatched emit none."

Mutation surfaces (all enumerated in 3.2/3.3 - the ONLY six sites that
write an inbound message row or unmatched row): twilio.ts :1975 (1:1),
:485 (relay), :848 (closed-group), :1570 (native group),
inboundEmail.ts thread() append, inboundEmail.ts putUnmatched. Seeds and
dev fixtures (lib/seed/*, routes/dev.ts) write message rows WITHOUT
going through these paths and must NOT push - they do not call the
webhook/ingest code, so they are structurally excluded; the plan adds no
push calls there.

Readers/renderers of the new state: dashboard/src/sw/display.ts +
route.ts + the sw.js verbatim mirrors (3.5); the notification data
allowlist; e2e specs that drive inbound sends (must stay green).
No other reader consumes push payloads.

## 8. Operator actions owed post-merge

None expected. VAPID is already configured on dev and prod; no new env
vars, no terraform, no secrets. Deploy of app + worker (the worker
gains push wiring) via the normal deploy path on the operator's go.
