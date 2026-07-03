# Send-time suppression / consent gates

Research for `scheduled-message-visibility` (Part B "suppression honesty"): map every
gate the outbound path applies at *fire time*, so a "future scheduled message" preview
can honestly say whether a queued send will go out, be suppressed, or be skipped.

**The one send path.** Every scheduled auto-send that persists to a 1:1 conversation
goes through **`app/src/services/sendMessage.ts` → `createSendMessageService()` →
`sendMessage(input)`** (the "send wrapper", doc §7.1). Both pollers call it:

- Tour reminders — `app/src/jobs/tourReminders.ts:310` (`processReminderRow`, tenant-1:1 route).
- Placement nudges — `app/src/jobs/placementNudges.ts:349` (`processNudgeRow`).
- Retry chain — `app/src/jobs/retrySend.ts:129`.

The gates below execute **in this order** inside `sendMessage`, each throwing a
`SendRefusedError` subclass (`app/src/services/sendMessage.ts:40-128`) BEFORE the
provider call. **There is NO reusable `canSendTo(contact)` / `evaluateSendGates()`
predicate** — the logic is inline in `sendMessage` (see "Reusability" at the end).

> **IMPORTANT exception — the group route bypasses ALL of this.** For
> `landlord_led` / `pm_team` tours with a usable masked group thread, tour reminders
> do **direct `adapter.sendMessage()` per member** (`tourReminders.ts:467`), NOT the
> wrapper — because the wrapper throws `RelaySendNotSupportedError` for `relay_group`
> convs. Only opt-out is re-checked there (via `isMemberSuppressed`); the kill-switch
> is re-checked in the Twilio driver; JIT-consent / breaker / manual-mode do NOT
> apply on that path. See gate table note "Group route" below. A preview for a
> landlord_led/pm_team tour reminder must evaluate the group-route predicates, not the
> 1:1 ones.

---

## Gate-by-gate

### Gate 0 — SMS kill-switch / global disable (`sms_sending_disabled`)

- **Check:** `app/src/services/sendMessage.ts:216`
  ```ts
  if (config.smsSendingEnabled === false) {
    log.warn({ conversationId }, 'send refused: SMS sending disabled (pre-A2P kill-switch)');
    throw new SmsSendingDisabledError();
  }
  ```
- **State source:** `config.smsSendingEnabled` — a **process-global** boolean from
  `SMS_SENDING_ENABLED` env, loaded in `app/src/lib/config.ts:448-462`. Default =
  `messagingDriver === 'console'` (true locally/test; **false on deployed twilio stacks
  until A2P approval**). Not per-contact — one flag for the whole stack.
- **On block:** WARN log, throws `SmsSendingDisabledError` (`code: 'sms_sending_disabled'`,
  route→HTTP 503). No status stamp, no outbox, no enqueue-for-later. In the pollers the
  claim is already stamped (`sentAt` set) so **the row is retired, not retried** — a
  scheduled reminder that comes due while the kill-switch is off is silently consumed.
- **Backstop:** `TwilioMessagingDriver.sendMessage` re-checks `sendingEnabled === false`
  and throws (`app/src/adapters/messaging.ts:397-405`) — this is what protects the
  group route's direct adapter sends.
- **Per-message at fire time?** Yes — read live at each send. A preview can read the
  same global config. Its value only changes on an operator flip, so a preview computed
  now is accurate unless the flag flips before the fire.

### Gate 0b — Relay-group guard (`relay_not_supported`)

- **Check:** `app/src/services/sendMessage.ts:223`
  `if (conversation.type === 'relay_group') throw new RelaySendNotSupportedError(...)`.
- **State source:** `conversation.type`. Not a suppression of a *person* — it's a
  routing guard. The pollers never hand a `relay_group` to the wrapper (tour group route
  goes direct-adapter; nudges explicitly target 1:1). Relevant only to note that a
  scheduled item's target conversation is always a 1:1 for the wrapper path.

### Gate 1 — Opt-out / STOP (`contact_opted_out`) — the firmest suppression

- **Check:** `app/src/services/sendMessage.ts:228-239`
  ```ts
  const contact = await contacts.findByPhone(conversation.participant_phone);
  if (conversation.sms_opt_out === true || contact?.sms_opt_out === true) {
    ...
    throw new ContactOptedOutError(conversationId);
  }
  ```
- **State source:** **EITHER** flag suppresses —
  - `conversation.sms_opt_out` (conversation row; `app/src/repos/conversationsRepo.ts:96`),
    covers STOPs from phones with no contact record yet;
  - `contact.sms_opt_out` (contact row; `app/src/repos/contactsRepo.ts:111`), resolved by
    `contacts.findByPhone(conversation.participant_phone)`.
  Set by the inbound STOP-keyword webhook (`OPT_OUT_KEYWORDS`, `smsCompliance.ts:169`).
- **On block:** WARN log, throws `ContactOptedOutError` (route→409/typed). Poller: claim
  already stamped → row retired, not retried (`tourReminders.ts:327-340`,
  `placementNudges.ts:367-380` treat `SendRefusedError` as by-design, no retry).
- **Per-message at fire time?** **Yes, and this is the honesty-critical one.** A contact
  currently sendable can text STOP before a scheduled reminder fires → the queued item
  will be suppressed. A preview MUST read *both* `conversation.sms_opt_out` and the
  contact's `sms_opt_out` (via `findByPhone`) at read time to be truthful, and label the
  item "will be skipped (opted out)" — but note it can flip either direction before fire.
- **Reusable predicate for the group route:** `isMemberSuppressed(contactsRepo, member)`
  in `app/src/jobs/relayFanOut.ts:225-234` returns `contact?.sms_opt_out === true`
  (resolved by `member.contactId` else `findByPhone(member.phone)`). This is the *closest
  thing to a reusable opt-out predicate* and is what the group tour-reminder route calls
  (`tourReminders.ts:457`).

### Gate 1.5 — JIT (just-in-time) consent (`contact_no_consent`)

- **Check:** `app/src/services/sendMessage.ts:250-256`
  ```ts
  if (automated === false && contact && !hasSmsConsent(contact)) {
    ...
    throw new ContactNoConsentError(conversationId);
  }
  ```
- **State source:** `hasSmsConsent(contact)` = `typeof contact.consent_method === 'string'
  && length > 0` (`app/src/lib/smsCompliance.ts:91-93`; field at
  `contactsRepo.ts:142`). THE single consent predicate.
- **CRITICAL for the preview:** this gate is **guarded by `automated === false`** — it
  fires ONLY for a HUMAN proactive send. **All scheduled auto-sends pass
  `automated: true`** (`tourReminders.ts:314`, `placementNudges.ts:353`,
  `retrySend.ts:134`), so **the JIT consent gate NEVER blocks a scheduled reminder/nudge.**
  A preview of a scheduled item should therefore **not** show a "no consent" suppression —
  it does not apply. (Rationale in code: automated sends have their own opt-in basis and
  there's no human/modal to capture consent at fire time.)
- **On block (human path only):** WARN, throws `ContactNoConsentError` (route→409, dashboard
  pops a consent modal + retries). Irrelevant to scheduled items.
- **Per-message at fire time?** N/A for scheduled (gate skipped when `automated`).

### Gate 2a — Manual-mode conversation (`manual_mode`)

- **Check:** `app/src/services/sendMessage.ts:260-261`
  ```ts
  if (automated) {
    if (conversation.ai_mode === 'manual') throw new ManualModeError(conversationId);
  ```
- **State source:** `conversation.ai_mode` (`conversationsRepo.ts:82`, type
  `ConversationMode`; set via `setMode`, `conversationsRepo.ts:853`). A conversation is
  flipped to `manual` either by a human taking over OR automatically by a breaker trip
  (see Gate 2b). **Relay threads are created `manual` by default** (`conversationsRepo.ts:361`).
- **On block:** throws `ManualModeError` (`code: 'manual_mode'`). Applies to **automated
  sends only** — human sends are always allowed and never counted. Poller: by-design
  refusal → claim retired, no retry.
- **Per-message at fire time?** **Yes.** A conversation can be flipped to manual (by staff
  or a breaker trip) between scheduling and fire → queued automated item will be
  suppressed. Preview should read `conversation.ai_mode` and show "will be skipped
  (conversation in manual mode)" when `=== 'manual'`.

### Gate 2b — Circuit breaker (`breaker_open`)

- **Check:** `app/src/services/sendMessage.ts:262-278`
  ```ts
  const count = await conversations.incrementAutomatedSendCount(conversationId, minuteBucket());
  if (count > config.sendBreakerMaxPerMinute) {
    await conversations.setMode(conversationId, 'manual');
    await audit.append(... 'mode_changed', { from:'auto', to:'manual', reason:'breaker_trip' });
    log.error(...);           // this ERROR line IS the alarm
    throw new CircuitBreakerOpenError(conversationId);
  }
  ```
- **State source:** a **per-conversation, per-minute counter** —
  `conversations.incrementAutomatedSendCount(conversationId, minuteBucket())` (atomic
  increment on the conversation row for the current minute bucket) compared to the global
  cap `config.sendBreakerMaxPerMinute`. This is **stateful and mutated by the act of
  sending** — it is NOT a pure predicate you can evaluate read-only without incrementing.
- **On block:** flips the conversation to `manual` (so all subsequent automated sends hit
  Gate 2a), writes an audit `mode_changed` event, logs at ERROR (pages the
  `hc-<env>-error-logs` alarm), throws `CircuitBreakerOpenError`. Poller: by-design →
  claim retired, no retry.
- **Per-message at fire time?** **Yes, and inherently un-previewable.** The breaker depends
  on how many automated sends fire in the same minute as the eventual fire — unknowable at
  read time. A preview canNOT honestly predict a breaker trip; the practical proxy is
  "if the conversation is already `manual` (Gate 2a), it's suppressed." Recommend the
  preview treat breaker as "cannot be sent while conversation is in manual mode" and rely
  on Gate 2a's `ai_mode` read.

### Gate 3 — provider throttle (not a suppression, informational)

- The Twilio driver emits a `send_throttled` marker on 429/30022 (`messaging.ts:428-434`)
  and rethrows. This is a transient provider rate-limit surfaced as a *non-refusal* error
  (NOT a `SendRefusedError`), so the poller does NOT treat it as by-design — but note the
  claim is already stamped so it still won't retry. Not a state a preview can read.

### NOT a send-path gate — API rate limits & quiet hours

- **Rate limits** in this repo are **per-user API middleware** (30/5/10 per min on
  dashboard routes — see memory "pre-golive-ops-slices"), NOT on the outbound send path.
  They gate a human hitting the send endpoint, never a poller. Irrelevant to scheduled items.
- **Quiet hours: there is NO quiet-hours / time-of-window gate anywhere in the send path.**
  Reminder `dueAt`s are computed at arm time (e.g. `morning_of` = 08:00 UTC,
  `tourReminders.ts:72-77`); nothing re-checks time-of-day at fire. Do not promise a
  "quiet hours" suppression — none exists.

---

## Which conversation a scheduled item targets (for the preview's thread placement)

- **Tour reminder, self_guided (or unusable group):** tenant's 1:1 — resolved by
  `contact.phone` → `conversationsRepo.findByParticipantPhone(phone)` → first conv of type
  `tenant_1to1 | unknown_1to1` (`tourReminders.ts:280-281`). If none, the reminder is
  **skipped entirely** (`tourReminders.ts:283-288`) — no conv created.
- **Tour reminder, landlord_led / pm_team with usable group:** the masked **group thread**
  (`tour.groupThreadId`), direct-adapter per member — bypasses the wrapper (see top note).
- **Placement nudge:** recipient = tenant (`placement.tenantId`) or landlord
  (`unit.landlordId`) per the rung (`placementNudges.ts:250-270`); phone →
  `findByParticipantPhone` → `tenant_1to1`/`landlord_1to1`/`unknown_1to1`. **If none exists
  it is CREATED on demand** via `createOrGetByParticipantPhone` and the send proceeds
  (`placementNudges.ts:294-330`) — "thread existence is NOT consent; the gates still apply".

## Stale-row / not-a-gate suppressions the preview must also honor

Beyond `sendMessage`'s gates, a row can be **retired without sending** for reasons the
preview should reflect as "won't send":

- **Canceled row:** `canceledAt` set (tour reschedule/cancel → `cancelForTour`; nudge
  stage-change → `cancelForPlacement`). `listDue` filters these out; the claim also
  blocks them. A canceled scheduled item should disappear / show "canceled".
- **Stale placement stage:** `placementNudges.ts:239-246` — if `placement.stage !==
  rungStage` at fire time, the row is **claimed and retired, NOT sent**. So a nudge
  preview is only honest if the placement is *still* in the arming stage; if the stage has
  moved on, the queued nudge will be silently dropped. This is a nudge-specific "will be
  skipped" predicate the preview should evaluate (`STAGE_BY_KIND` reverse-index +
  `placement.stage`).
- **Missing entity:** tour/contact/unit/phone missing → warn + skip (various lines).
- **`retrySend`** additionally has an idempotency `putJobExecutionMarker` guard
  (`retrySend.ts:106`) — not a suppression, a duplicate-delivery guard.

`statusTransition.ts` (`app/src/services/statusTransition.ts`) — swept, **sends no SMS**.
It only sets the board `next_deadline` slot (a dashboard deadline, incl. the orphaned
`tour_reminder` type); no `sendMessage` / `adapter.sendMessage` call exists there.
`adapters/scheduler.ts` is pure enqueue machinery (EventBridge/SQS), not a send path.

---

## Reusability: is there a `canSendTo()` the preview can call?

**No.** All gates are **inline** in `sendMessage` (`sendMessage.ts:204-341`) and several
are **stateful/mutating** (breaker increments a counter; a trip writes `setMode` + audit),
so they cannot be evaluated read-only as-is. The only extractable pure/read-only pieces:

| Gate | Read-only predicate available? | Where |
|------|-------------------------------|-------|
| kill-switch | yes — `config.smsSendingEnabled === false` | `config.ts` global |
| opt-out | yes — `conv.sms_opt_out === true \|\| contact.sms_opt_out === true`; or reuse `isMemberSuppressed()` | `sendMessage.ts:229`, `relayFanOut.ts:225` |
| JIT consent | yes — `hasSmsConsent(contact)` — **but N/A for scheduled (automated)** | `smsCompliance.ts:91` |
| manual mode | yes — `conv.ai_mode === 'manual'` | `sendMessage.ts:261` |
| breaker | **no** — requires an atomic increment; only proxy is "already manual" | `sendMessage.ts:262` |
| stale-stage (nudge) | yes — `placement.stage === STAGE_BY_KIND[kind]` | `placementNudges.ts:239` |
| canceled row | yes — `row.canceledAt == null && row.sentAt == null` | repos `listDue` |

**Recommendation for the planner.** Extract a pure `evaluateScheduledSendSuppression(...)`
helper that, given `{conversation, contact}` (+ for nudges the placement/rung), returns a
suppression reason for the **read-only-evaluable** gates: `sms_sending_disabled`,
`contact_opted_out`, `manual_mode` (which also subsumes a tripped breaker, since a trip
flips to `manual`), plus the row-level `canceled` / `stale_stage`. Deliberately **omit
JIT-consent** (never applies to automated) and **omit live breaker prediction**
(un-evaluable). Have `sendMessage`'s Gates 0/1/2a call the same helper so the preview and
the real send share one definition and cannot drift — today they would duplicate logic.
Always caveat the preview: opt-out / manual-mode / kill-switch can flip between read and
fire, so the item is a *current best estimate*, transitioning in place when it actually
fires (or is retired).
