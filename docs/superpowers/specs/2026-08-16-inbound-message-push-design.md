# Inbound-Message Push Notifications - Design Spec

Date: 2026-08-16 (rev 2, post adversarial review round 1)
Branch: feat/inbound-message-push (worktree W:\tmp\inbound-message-push, cut
from main @d0c28678)
Origin issue: docs/issues/no-push-on-inbound-message.md
Adjudications: .superpowers/design-review/adjudications.md

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
  via the notification tag, alerting on EVERY message (renotify) exactly
  like a native SMS thread; NO additional server-side throttle.
- D3 Quiet hours: device do-not-disturb ONLY. Org quiet hours are
  outbound-only and must NOT gate staff-facing pushes.
- D4 Content: full sender + message content in the push, like a native
  SMS app. Lock-screen privacy is the device's job. NOTE: this is a
  deliberate amendment of the masked voice-push posture (voice.ts
  comments cite "a role/name, NEVER a raw phone") - message pushes carry
  real names, phone-number fallbacks, and message text by operator
  decision. The voice-push comments remain true for the voice kinds.
- D5 Scope: "message" = any inbound message channel - SMS/MMS and email.
- D6 Unmatched email: pushes too, deep-linking to the /email triage page
  (requires a small service-worker change). Only a FRESHLY CREATED
  unmatched-store row with status 'unmatched' pushes; rows put with any
  other status (quarantined / dismissed) never push, and a re-put of an
  existing row never pushes. Note: a spam-verdict mail from a KNOWN
  contact threads normally (existing match-beats-spam behavior,
  inboundEmail.ts:599-603) and therefore pushes as a matched email -
  "spam never pushes" applies to the unmatched store, not to threaded
  mail.
- D7 Reingest: when staff click "Link to contact" and the ingest re-runs
  with the reingest flag, NO push is emitted (old mail being filed, and
  the acting staff member is looking at it).
- D8 Copy: push titles/bodies are inline literals at the send site,
  matching the four existing push sends. Push copy is staff-facing; this
  is a DELIBERATE exception to the AGENTS.md message-catalog rule, on
  the voice-push precedent (the catalog is contact-facing).

Planner-settled technical decisions:

- D9 TTL: none (web-push default). Message pushes are late-better-than-
  never, exactly like missed_call and voicemail. Pinned by test.
- D10 Enumeration: recipients come from usersRepo.listAll() (the accepted
  tiny-table scan pattern; listByRole is listAll + filter already).
  Everyone means admin AND va roles - all users. No status filtering:
  subscription PRESENCE is the filter (an invited-never-signed-in user
  has no subscriptions and costs nothing - see 3.1).
- D11 Emission is fire-and-forget (void promise + .catch log) at every
  site: a push must never delay or fail a webhook ack or the email
  ingest. This copies the pre_ring pattern (voice.ts:623-633).
- D12 Truncation: every push title/body passes through a shared
  capPushText() helper (new module app/src/lib/pushText.ts) at the send
  sites - title capped at 100, body at 300, counted in CODE POINTS
  (Array.from, so surrogate pairs/emoji are never split), with ASCII
  "..." appended on truncation and the RESULT INCLUDING the suffix never
  exceeding the cap. Rationale: an uncapped matched-email body can be
  the stored body text (capped at 100KB at ingest), and a web-push
  payload over ~4KB is REJECTED by the push service with a non-Gone
  status - counted failed, subscription kept, so the oversize push
  fails silently and would fail again forever. The cap must be
  server-side at the send site.

## 3. What gets built

### 3.1 pushService.sendToAll (app/src/services/pushService.ts)

New method on the existing PushService interface:

    sendToAll(notification: PushNotification): Promise<SendToAllResult>

Behavior:

- If push is unconfigured (VAPID unset): ONE log line (warn) and a
  zeroed result. Never one line per user.
- Otherwise: usersRepo.listAll() ONCE, then fan out over the returned
  items directly - listAll already returns full items including
  push_subscriptions; the SEND path must NOT re-read each user via
  findById. (The PRUNE path is the exception: a Gone endpoint triggers
  removePushSubscription, which internally re-reads the user - that is
  the existing exceptional path, unchanged.) Users with zero
  subscriptions are skipped silently (no I/O, no log line).
- The per-device loop (allowlist prune, Gone prune, transient keep) is
  shared with sendToUser via an internal helper so the two methods
  cannot drift; sendToUser keeps its exact current behavior and log
  lines (the voice paths and their tests are untouched). Logging
  precision: the per-device EXCEPTION warns inside the shared loop
  (allowlist prune, transient failure) are kept in BOTH methods - they
  are rare and diagnostic. What sendToAll drops are sendToUser's
  per-CALL info lines ("no subscriptions", "sendToUser complete"),
  replaced by the one aggregate line below.
- Per-USER isolation: one failing user never aborts the fan-out (the
  voice founder-loop shape, voice.ts:1858-1864).
- If listAll() itself throws: log error, return zeroed result - never
  throw (mirrors resolveFounders, voice.ts:716-724).
- Logging: ONE aggregate line per notification - kind + user/device
  counts ({ users, attempted, sent, pruned, failed }), never the
  payload, never per-user lines.
- Result: { configured, users, attempted, sent, pruned, failed } where
  users = users that had at least one subscription.
- PII posture unchanged: log kind + counts only, never the payload.

Voice sends are NOT migrated to sendToAll in this feature (no behavior
change to pre_ring/missed_call/voicemail; their recipient semantics are
holder/admin-only and out of scope).

### 3.2 Emit sites - SMS/MMS (app/src/routes/webhooks/twilio.ts)

The invariant, scoped to the two MESSAGING channels (the Twilio
messaging webhook and the email ingest service): EVERY fresh inbound
message append on these channels emits exactly ONE push fan-out; a
deduped redelivery, an echo drop, a reingest, or a non-fresh /
non-'unmatched' quarantine emits NONE. Voice call/voicemail rows in
voice.ts are also direction:'inbound' message rows but are deliberately
OUTSIDE this invariant - they carry their own push kinds (pre_ring /
missed_call / voicemail) and must not gain 'message' pushes.

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
- Relay appends that skip fan-out still push: a closed-thread reply, a
  removed-member reply, and the unknown-sender open-group fallback all
  persist fresh rows, so all push, using the sender fallback chain in
  3.4.
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
- UNMATCHED email: in quarantineRow. The emit condition is LITERALLY:

      created === true && row.status === 'unmatched' && !reingest

  All three conjuncts are load-bearing: putUnmatched uses a
  DETERMINISTIC id (um-<sha256(bucket/key)[:32]>), so an SQS redelivery that
  died between putUnmatched and the object-marker claim re-puts the same
  row with created === false and must not re-push; rows created with
  status 'quarantined' (oversize / parse-fail / virus / spam-unknown) or
  'dismissed' (blocklist) must never push. NOTE: this condition is
  DELIBERATELY NARROWER than the unmatched_email.updated SSE (which
  fires on created && status !== 'dismissed', i.e. including
  quarantined rows) - do not copy the SSE condition.

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
conversationId) - the service worker reads kind/ids at the JSON root.
NEVER nest under data (the /api/push/test payload nests and its kind is
silently dropped; do not copy it). Every title/body passes through
capPushText (D12).

Shared helpers this feature EXTRACTS (authorized refactors):

- relayThreadLabel(conversation) in app/src/lib/groupTitle.ts, carrying
  the inbox's exact precedence chain (member names -> placement_tag ->
  formatted pool_number -> "Relay group") currently inlined in
  routes/inbox.ts relayRowFor (:619-635). inbox.ts is re-pointed to the
  helper so push/inbox parity holds by construction. SCOPE GUARD: only
  inbox.ts relayRowFor is re-pointed. Other relay-label chains in the
  app (notably poolNumbersAdmin.ts serverLabel, which is a DELIBERATELY
  different precedence pinned by its own test) are NOT consolidated -
  the helper's doc comment must say so, so a later maintainer does not
  "finish" a consolidation that was never intended.
- contactDisplayName(contact) in app/src/lib (new small module): the
  firstName/lastName join with trimming. Used by the new push sites
  ONLY; the five existing private copies (routes/contacts.ts,
  routes/units.ts, lib/rosterResolution.ts, services/groupMembers.ts,
  services/inboundEmail.ts) are left alone - consolidating them is
  filed as a follow-up issue, not scope-crept here.

kind 'message' (has a conversationId; tag becomes message:<convId>):

| Path | title | body |
|------|-------|------|
| 1:1 SMS (+ closed-group intercept) | contactDisplayName(contact), else the conversation's participant_display_name, else formatPhoneForDisplay(From) | body rules below |
| Relay-group inbound | relayThreadLabel(relay) | "<sender>: <Body>" where <sender> = roster sender.name, else contactDisplayName(senderContact), else formatPhoneForDisplay(From); media-only: "<sender> sent an attachment." |
| Native group text | groupThreadLabel(thread.participants) (the canonical title, lib/groupTitle.ts:29) | "<sender>: <Body>" with the same sender fallback chain (roster/contact name, else phone); media-only: "<sender> sent an attachment." |
| Matched email | contactDisplayName(threadContact) - the contact binding thread() actually receives (the tier-5 roster/thread contact, or the tier-6 findByEmail match), NOT the bare tier-6 lookup when the thread resolved differently - else the parsed from-name, else the from address | subject if non-empty, else the stored message body text (the field capped at 100KB at ingest), through capPushText |

Body rules for SMS/MMS (1:1 and closed-group rows):

- Body text present: the body text (no attachment suffix when media
  rides along - native SMS behavior).
- Media-only (no body text): "Sent an attachment."
- Neither body nor media (rare but possible - the append only sets body
  when Body.length > 0): the push still fires with an empty body; the
  SW renders title-only (display.ts d.body || '').

Rules:

- Sender-name derivation uses only values already in scope at each
  persist point (contact at twilio.ts:1959, senderContact at :469 and
  :1541-1549, roster participant names, From). No new repo lookups are
  added on the hot path; formatPhoneForDisplay and the two helpers are
  pure.
- Closed-group intercept renders as a plain 1:1 message (it files into
  the sender's 1:1). No "(via group)" suffix in v1.

kind 'unmatched_email' (no conversationId, no per-row id in the
payload):

| title | body |
|-------|------|
| parsed from-name, else the from address | subject, else the stored 180-char snippet |

The unmatched notification is a QUEUE entry wearing the NEWEST
arrival's copy: because the tag is queue-level (3.5), each new
unmatched email replaces the shade entry in place, so only the latest
sender/subject is visible there. Earlier arrivals' identities live
only on /email. This is deliberate - the entry represents the queue,
its copy represents the latest item.

### 3.5 Client change (dashboard service worker)

Tested-mirror pattern (dashboard/src/sw/display.ts + route.ts are the
tested source of truth; dashboard/public/sw.js carries verbatim copies -
BOTH must be updated). Three behavior changes:

- RENOTIFY (delivers D2): display.ts gains an alerting rule - kinds
  'message' and 'unmatched_email' set renotify: true (with their tag)
  while remaining NON-time-sensitive (requireInteraction stays false,
  reserved for missed_call/pre_ring). Without this, a same-tag
  replacement is SILENT and every message after the first in a thread
  would not alert - the opposite of native messaging. (The existing
  renotify expression is timeSensitive && Boolean(tag); it becomes a
  distinct alerting set: time-sensitive kinds keep requireInteraction,
  and message/unmatched_email join them for renotify only.) Caveat,
  stated honestly: renotify is an Android/Chrome lever (the deployed
  target - the org runs Android PWAs); iOS Safari same-tag re-alert
  behavior is UNVERIFIED and not a ship gate here.
- UNMATCHED TAG (queue-level): notificationTag returns 'unmatched_email'
  (the bare kind, no id) for kind 'unmatched_email'. ONE shade entry
  for the whole triage queue, replaced in place by each new unmatched
  arrival, alerting each time via renotify. No unmatchedId travels in
  the payload; the notification data allowlist (C1) is UNCHANGED
  ({kind, callId, conversationId} only). Accepted staleness: after a
  staffer files/dismisses the last unmatched row, an already-shown
  queue notification is not retroactively closed (no later push exists
  to close it; staleTagsFor cannot fire) - its tap lands on the live
  /email queue, which is self-correcting. At most one such entry can
  exist.
- ROUTING: route.ts resolveSafePath resolves kind 'unmatched_email' to
  '/email'; assertSameOriginPath's allowlist adds exact-match '/email'
  (NOT a prefix - /email/quarantine is not a push target).

Coverage:

- display.test.ts + route.test.ts pin: the renotify set (message,
  unmatched_email, missed_call, pre_ring alert; requireInteraction
  still only missed_call/pre_ring), the queue tag, the '/email' route
  + allowlist (including rejection of '/email/quarantine'), and that
  conversationId payloads still route to /conversations/<id>.
- MIRROR SMOKE TEST (new): a dashboard unit test reads
  dashboard/public/sw.js as TEXT and asserts the new tokens/branches
  exist in it ('unmatched_email', the '/email' allowlist entry, the
  renotify expression). Rationale: nothing else verifies the mirror -
  the tested modules never run in the browser and sw.js has been lost
  wholesale before (its own header says so). Full source-equality
  checking stays out of scope.

kind 'message' display/tag/deep-link otherwise already works (tag
message:<conversationId>, tap routes to /conversations/<id>) - the
renotify rule is the only display change it needs.

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
  recipient semantics, TTLs, and payloads stay byte-identical), and no
  'message' pushes for voice.ts's call/voicemail inbound rows.
- No migration of routes/push.ts test payload's nested-data quirk.
- No pushsubscriptionchange handler (already filed:
  docs/issues/push-subscription-change-not-handled.md).
- No e2e push seam (fake push endpoint / dev outbox for pushes). The
  voice pushes shipped with unit-harness coverage only; this feature
  follows that precedent. The builder files the seam idea as a follow-up
  issue.
- No consolidation of the five existing private display-name helpers
  (follow-up issue).
- No optimistic locking on push_subscriptions read-modify-writes
  (accepted risk - see section 5; follow-up issue filed by the builder).
- No badge/unread-count integration, no notification actions on message
  pushes in v1, no retroactive clearing of the unmatched queue
  notification (see 3.5).

## 5. Volume and scale analysis

- Team size: the users table is invite-only and tiny (seed: 1 admin +
  1 va; prod: single-digit staff). MAX_PUSH_SUBSCRIPTIONS = 10 per
  user. Worst-case fan-out per inbound message: users x devices,
  realistically a handful of POSTs, hard-bounded by 10 per user.
- Group fan-in is safe by construction: ONE inbound group/relay message
  produces ONE message row (relay fan-out sends provider SMS, never new
  rows), so the 132 imported group threads multiply nothing. Stated
  consequence of title parity: imported rosters are NAMELESS, so their
  group-push titles render from member phones/contact names (e.g.
  "With (555) 010-0002 & ..."), exactly as the inbox does today;
  titles improve as contacts get named, with no push-side work.
- ACCEPTED (by D2, stated honestly): bursts across N DISTINCT
  conversations do not coalesce - N replies to a broadcast are N
  alerting notifications, exactly as a native SMS app behaves with N
  active threads. No server throttle by decision.
- ACCEPTED (email): anything reaching the inbound address that is not
  SES-hard-spam-from-a-stranger or blocklisted becomes a fresh
  unmatched row and alerts every subscribed device (one queue-level
  shade entry, one alert per arrival). Vendor mail and newsletters land
  here. The damping mechanism is the queue-level tag (no entry pileup);
  the alert-per-email is the operator's native-semantics decision. If
  real-world volume proves noisy, the lever is a future per-kind
  preference, out of scope here.
- listAll() is a paginated Scan of the tiny users table. The voice
  missed-call push already accepts this scan on the call path
  (voice.ts:710-724); this feature EXTENDS that acceptance to the
  inbound-message path, which is higher-frequency - accepted in writing
  at current team scale, revisit with a GSI if the users table grows.
  sendToAll performs NO additional per-user reads (3.1).
- ACCEPTED RISK (write path): subscription pruning is a whole-list
  read-modify-write with no version condition (usersRepo.ts:581-631).
  Moving prunes onto the message path from two processes (app webhook +
  mail worker, fire-and-forget) makes lost-updates possible in two
  shapes: a prune overlapping a re-subscribe silently clobbers the
  fresh subscription, and two concurrent prunes of DIFFERENT dead
  endpoints on the same user can resurrect one of them (each stale
  read still contains the other's endpoint). Both need overlapping
  writes on one user item in the same instant; recovery is the next
  Gone prune or re-toggling notifications in Settings. Accepted at
  team scale; the builder files
  docs/issues/push-subscription-prune-rmw-lost-update.md and amends the
  stale premise comment at usersRepo.ts:585-587.
- The sends are serial per user/device and fire-and-forget off the
  request path (D11), so webhook latency is unaffected.

## 6. Testing strategy

Unit (app):

- pushService.sendToAll: fan-out across users using the listAll items
  (NO per-user findById on the SEND path - pinned by asserting the fake
  repo's findById is never called in a fan-out with NO Gone endpoints;
  a Gone-prune case may legitimately read via removePushSubscription),
  zero-subscription users skipped silently, per-user
  failure isolation, listAll-throw safety, unconfigured single-log
  no-op, ONE aggregate log line, aggregate tally, TTL absence (adapter
  receives undefined options - pins D9), PII (payload never logged),
  capPushText behavior (boundary: at-cap unchanged, over-cap truncated
  with "...").
- twilioWebhookHarness (world.pushBroadcasts - see section 7) per path:
  1:1 SMS pushes with contact-name title; MMS media-only body; MMS with
  body shows body text; relay push with relayThreadLabel title +
  sender-prefixed body; relay removed-member/unknown-sender pushes with
  phone-fallback sender; closed-group intercept pushes as 1:1; native
  group push with groupThreadLabel title; webhook REDELIVERY (dedupe)
  pushes nothing; echo drop pushes nothing; keyword STOP still pushes.
  All existing voice push tests stay green byte-identical
  (world.pushSends untouched).
- inboundEmail tests: matched email pushes (title/body rules, subject
  else body-text); rfc-id redelivery pushes nothing; unmatched pushes
  kind 'unmatched_email'; created===false re-put pushes nothing;
  quarantined (oversize/parse-fail/virus/spam-unknown) and dismissed
  push nothing; reingest pushes nothing (both matched and unmatched
  branches); spam-from-known-contact threads AND pushes as matched.
- inbox relay-label parity: relayRowFor still produces the same labels
  after re-pointing to relayThreadLabel (existing inbox tests must stay
  green; add one if none pins the precedence chain).
- Worker wiring: worker constructs pushService and threads it into
  ingest deps (construction/shape test or typecheck-backed).

Unit (dashboard):

- display.test.ts: renotify true for message + unmatched_email (tags
  present), requireInteraction still only missed_call/pre_ring; queue
  tag 'unmatched_email'; message tag unchanged; data allowlist
  unchanged.
- route.test.ts: kind unmatched_email resolves to '/email';
  assertSameOriginPath allows exact '/email', still rejects
  '/email/quarantine' and everything else; conversationId payloads
  still win and route to /conversations/<id>.
- Mirror smoke test: public/sw.js source contains the new
  tokens/branches (3.5).

e2e:

- Full suite green (no push seam exists; no new e2e spec for push
  display - see Non-goals). Inbound-message e2e specs must not break:
  push emission is fire-and-forget and no-ops without VAPID, so the
  hermetic lane sees at most one quiet log line per message.

## 7. Invariant surface enumeration (mutation + reader sweep)

Invariant (channel-scoped, see 3.2): "every fresh inbound message append
on the messaging channels emits exactly one push fan-out;
dedupe/echo/reingest/non-fresh-or-non-'unmatched' quarantine emit none."

Mutation surfaces - the ONLY sites that write an inbound message row or
unmatched row on the messaging channels: twilio.ts :1975 (1:1), :485
(relay), :848 (closed-group), :1570 (native group), inboundEmail.ts
thread() append, inboundEmail.ts putUnmatched. Explicitly excluded
writers of direction:'inbound' rows: voice.ts (:572/:801/:871 - call
entries and voicemail rows, own push kinds, must NOT gain message
pushes); lib/seed/* and routes/dev.ts (write rows without the
webhook/ingest code paths; must NOT push; structurally excluded because
no push call is added there).

Readers/renderers and type-surface impacts:

- dashboard/src/sw/display.ts + route.ts + the sw.js verbatim mirrors
  (3.5), including the notification data allowlist.
- The PushService interface change breaks BOTH in-repo test doubles:
  app/test/helpers/twilioWebhookHarness.ts:1819-1824 (the world.pushSends
  fake) and the never-resolving fake in app/test/founderTriage.test.ts.
  Both gain sendToAll; the harness records sendToAll calls into a NEW
  world.pushBroadcasts array ({ notification }), leaving
  world.pushSends and every existing voice assertion untouched.
- routes/inbox.ts relayRowFor is re-pointed to relayThreadLabel (3.4) -
  a reader refactor whose parity is pinned by test.
- e2e specs that drive inbound sends (must stay green; push no-ops
  without VAPID).

## 8. Operator actions owed post-merge

- No new env vars, no terraform, no secrets: VAPID is already configured
  on dev and prod and the worker shares the app's .env (docker-compose
  env_file), so the worker's new push wiring needs nothing.
- Deploy app + worker via the normal deploy path on the operator's go
  (the worker gains push wiring, so BOTH containers must roll).
- POST-DEPLOY VERIFICATION (required for D1 to mean anything): each
  staff member must subscribe on each device they want notified -
  Settings > Notifications > enable, then prove delivery with the
  existing "Send test notification" button. A user who never subscribes
  receives nothing, silently, by design.
- OPERATOR AWARENESS (local dev): a live-mode `npm run dev` loop with
  real VAPID keys now fires REAL pushes to every subscribed staff
  device on every inbound text/email it ingests - consistent with the
  established live-dev comms posture (real Twilio/SES), but new for
  push. The hermetic e2e lane is unaffected (no VAPID).
