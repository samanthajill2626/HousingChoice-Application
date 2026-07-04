# Message-Catalog Implementation Worklist (research output)

Authoritative spec: `docs/superpowers/specs/2026-07-03-message-catalog-design.md`.
Every `file:line` below was re-verified against the CURRENT tree on branch
`feat/message-catalog` (spec line numbers were approximate). Strings are quoted
byte-for-byte from source. **Byte fidelity is the prime directive.**

Legend: quoted defaults show the EXACT source spelling, including whether the
source used single- or double-quotes and `\'` escapes (JS string *value* is what
must be preserved, not the quote style).

---

## 1. Literals to MOVE into the catalog (spec §4)

### 1.1 Tour reminders — `jobs/tourReminders.ts` `REMINDER_BODIES`
Definition: `app/src/jobs/tourReminders.ts:48-54` (`export const REMINDER_BODIES: Record<ReminderKind, string>`).
Read at two send sites: `:290` (1:1 route) and `:432` (group route). `class:'operational'`, `channel:'sms'`, `editable:true`, no vars.

| catalog id | source line | exact `default` value |
|---|---|---|
| `tour.confirmation` | `:49` | `[AUTO] Your tour is confirmed. We'll send reminders as it approaches.` |
| `tour.day_before` | `:50` | `[AUTO] Reminder: your property tour is tomorrow.` |
| `tour.morning_of` | `:51` | `[AUTO] Good morning! Your property tour is today.` |
| `tour.en_route` | `:52` | `[AUTO] Your tour is coming up soon. Text us when you're on the way!` (source is single-quoted with `\'`) |
| `tour.no_show_checkin` | `:53` | `[AUTO] Hi! We noticed you may have missed your tour. Want to reschedule?` |

### 1.2 Placement nudges — `jobs/placementNudges.ts` `NUDGE_RUNGS`
Definition: `app/src/jobs/placementNudges.ts:57-82` (`export const NUDGE_RUNGS: Partial<Record<PlacementStage, NudgeRung>>`). The `body:` field is read/sent at `:381` (`body: rung.body`). `class:'operational'`, `channel:'sms'`, `editable:true`, no vars. Note the `NudgeRung` interface keeps `kind`/`recipient`/`delayMs` in code — only `body` moves to the catalog; the resolver is keyed by the catalog id, `kind`/`recipient`/`delayMs` stay in `NUDGE_RUNGS`.

| catalog id | stage / line | recipient | exact `default` value |
|---|---|---|---|
| `nudge.receipt_check` | `awaiting_receipt` `:62` | tenant | `[AUTO] Just checking in — did the rental application come through? Let us know if you need it re-sent.` |
| `nudge.completion_check` | `awaiting_completion` `:68` | tenant | `[AUTO] How is the application coming along? Text us here if you are stuck on anything.` |
| `nudge.approval_check` | `awaiting_approval` `:74` | landlord | `[AUTO] Checking in — any decision yet on the application we sent over?` |
| `nudge.rta_window_closing` | `awaiting_landlord_submission` `:80` | landlord | `[AUTO] Friendly reminder — the 48-hour RTA window is closing. Have you been able to submit it?` |

> The em-dash `—` (U+2014) appears in three of these — preserve the exact character.

### 1.3 Relay intro — `jobs/relayFanOut.ts` `composeIntroBody`
- `composeIntroBody`: `app/src/jobs/relayFanOut.ts:160-182`. Called at `:485` (`const body = composeIntroBody(roster.map((m) => m.name));`).
- The identity prefix concat is `:181`: `return \`${RELAY_INTRO_IDENTITY} ${connection}\`;` — the leading `RELAY_INTRO_IDENTITY` + a single space folds INTO the `relay.intro` default (spec §7).
- catalog id `relay.intro`, `class:'operational'`, `channel:'sms'`, `editable:true`, vars: `['members']`.

**The default template** should be `{RELAY_INTRO_IDENTITY} {members}` — i.e. the imported `RELAY_INTRO_IDENTITY` const value (`Tenant Place LLC. Reply STOP to opt out.`) + a space + `{members}`. The `{members}` token is fed by the count-plurality / Oxford-list logic that MUST STAY IN CODE (`:161-180`):
  - `named.length === 0` → count phrasing: `You're now connected with N other person|people on this number. Reply here and everyone in the group sees it.` (or the `others === 0` variant: `You're now connected on this number. Reply here and the group sees it.`)
  - 1 name → `<name>`; 2 → `<a> and <b>`; ≥3 → `<all-but-last joined by ", ">, and <last>`, wrapped in `You're now connected with <list> on this number. Reply here and everyone in the group sees it.`

So the *code* computes the `connection` string and passes it as `{ members: connection }`; the resolver prepends the identity via the default template. Net sent text is byte-identical to today.

> Do NOT move `composeRelayBody` (`:145-148`, the `<SenderName>: <body>` per-message wrapper) — spec §4.6 keeps it a function (transform over live user text). `TEAM_SENDER_LABEL`/`ANONYMOUS_SENDER_LABEL` also stay in code.

### 1.4 Voice `<Say>` — `routes/webhooks/voice.ts`
All `class:'voice'`, `channel:'voice'`, `editable:false`. The TwiML wrapper is what varies — each entry below records the EXACT wrapper so the migration preserves it. `resolveMessage('voice.…', {…})` returns the string; the call site keeps the surrounding `new VoiceResponse()` / `.say()` / `.gather()` / `.hangup()` structure unchanged.

| catalog id | current line | vars | wrapper | exact copy |
|---|---|---|---|---|
| `voice.whisper_founder` | `:1026` | `callerLabel` | `gather.say(...)` (inside `vr.gather` numDigits 1, timeout 8; then `vr.hangup()`) | `You have a Housing Choice call from {callerLabel}. Press 1 to accept.` |
| `voice.whisper_relay` | `:1027` | `callerLabel` | same `gather.say(...)` ternary branch (non-founder) | `You have a Housing Choice call from {callerLabel}. Press 1 to accept, or press 0 to reach the team.` |
| `voice.whisper_outbound` | `:976` | `targetLabel` | `gather.say(...)` (outbound-bridge `vr.gather`; then `vr.hangup()`). NOTE source token is `target.label` | `Calling {targetLabel}. Press 1 to connect.` |
| `voice.caller_label_default` | `:997` | — | plain fallback string assigned to `callerLabel` when `q['callerLabel']` absent (NOT a `<Say>`) | `a Housing Choice contact` |
| `voice.team_unreachable` | `:1176` | — | `vr.say(...)` then `vr.hangup()` (press-0 with no team number) | `Sorry, the team is not reachable right now. Please try again later.` |
| `voice.greeting_no_holder` | `:417` | — | `maskedSayHangup(...)` (`vr.say` + `vr.hangup`) | `Thank you for calling Housing Choice. Please send us a text message, and we will get back to you.` |
| `voice.self_call` | `:437` | — | `maskedSayHangup(...)` | `Thanks for calling Housing Choice. Please reach us from a different line, or send a text message. Goodbye.` |
| `voice.founder_refuse` | `:476` | — | `maskedSayHangup(...)` | `Sorry, no one is available to take your call right now.` |
| `voice.thread_closed` | `:740` | — | `maskedSayHangup(...)` | `Sorry, this Housing Choice connection is no longer available. Please send us a text message instead.` |
| `voice.masked_refuse` | `:752` | — | `maskedSayHangup(...)` | `Sorry, this Housing Choice connection is not available right now.` |
| `voice.outbound_unavailable` | `:960` | — | `maskedSayHangup(...)` | `Sorry, this Housing Choice call is no longer available. Goodbye.` |
| `voice.missed_call_goodbye` | `:1371` | — | `reply.say(...)` then `reply.hangup()` (inside `/status`, gated on `isMissed`) | `Sorry we missed your call. Please send us a text message and we will get right back to you. Goodbye.` |

**Borderline / dead-path flags (spec asks to tag):**
- `voice.founder_refuse` (`:476`) is under `/* c8 ignore next 5 */`; `decideFounderRouting` only ever returns `'ring-founder'` (`:164-173`), so the `decision !== 'ring-founder'` branch is UNREACHABLE today. Include in catalog, tag dead.
- `voice.masked_refuse` (`:752`) is under `/* c8 ignore next 4 */`; `decideRouting` only returns `'bridge'` (`:147-153`) → UNREACHABLE today. Include, tag dead.
- `voice.caller_label_default` is not a `<Say>` — it's the default value for the `callerLabel` query param. It IS interpolated into `voice.whisper_founder`/`voice.whisper_relay` downstream. Moving it to the catalog is fine but the call site is a `q['callerLabel'] ?? '<default>'` assignment, not a resolver-wrapped send — implementer may keep it as a plain catalog const read.

### 1.5 Cell verification — `lib/cellVerification.ts` `renderCellVerifySms`
Definition: `app/src/lib/cellVerification.ts:42-44`. Sent at `app/src/routes/voiceApi.ts:237` (`await adapter.sendMessage({ to: cell, body: renderCellVerifySms(code) });`). catalog id `verify.cell_code`, `class:'transactional'`, `channel:'sms'`, `editable:false`, vars `['code']`.

Exact default: `Your HousingChoice verification code is {code}. It expires in 10 minutes.`

> Uses the INTERNAL name "HousingChoice" (NOT the SMS brand `Tenant Place LLC`) — preserve verbatim (spec §4.5). Keep `renderCellVerifySms(code)` as a thin wrapper delegating to `resolveMessage('verify.cell_code', { code })` so `voiceApi.ts` and `cellVerification.test.ts` importers keep working.

---

## 2. Compliance strings to REFERENCE-BY-IMPORT (spec §4.2/§4.3)

All live in `app/src/lib/smsCompliance.ts` and must be IMPORTED by the catalog, never re-literaled. The catalog module lives at `app/src/messages/` so it can import `../lib/smsCompliance.js` directly.

| export name | line | current value | catalog id | class / editable |
|---|---|---|---|---|
| `WELCOME_SMS` | `:123` | `` Welcome to ${SMS_BRAND_NAME}! You're signed up for new properties that accept your voucher, plus tour reminders and updates. Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help. `` | `welcome.sms` | operational, `editable:true`, `requiresOptOut:true`, vars `['firstName']` |
| `DEFAULT_MISSED_CALL_AUTOTEXT` | `:150` | `` ${SMS_BRAND_NAME}: Sorry we missed your call! To get started, please text us your full name, voucher size, and housing authority and we'll be right with you. Reply STOP to opt out. `` | `missed_call.autotext` | operational, `editable:true`, `requiresOptOut:true` |
| `STOP_CONFIRMATION` | `:126` | `You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.` | `keyword.stop` | compliance-locked, `editable:false` |
| `HELP_REPLY` | `:133` | `` ${SMS_BRAND_NAME}: housing listing alerts for voucher holders. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out. More info: tenant.place. `` | `keyword.help` | compliance-locked, `editable:false` |
| `WEB_FORM_CONSENT_COPY` | `:140` | `` I agree to receive recurring texts from ${SMS_BRAND_NAME} about new properties that accept my voucher, tour reminders, and updates. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. See our Privacy Policy and Terms. `` | `consent.web_form` | compliance-locked, `editable:false` |
| `RELAY_INTRO_IDENTITY` | `:157` | `` ${SMS_BRAND_NAME}. Reply STOP to opt out. `` (= `Tenant Place LLC. Reply STOP to opt out.`) | `relay.identity` | compliance-locked, `editable:false` (used as the prefix component of `relay.intro`) |

- `SMS_BRAND_NAME` = `Tenant Place LLC` (`:24`). All the `${SMS_BRAND_NAME}` strings resolve through it — keep that single point of change (spec §7.1).
- `DEFAULT_MISSED_CALL_AUTOTEXT` is NOT in `settingsRepo`; it is imported INTO `settingsRepo` at `app/src/repos/settingsRepo.ts:20` and used as `DEFAULT_ORG_SETTINGS.missedCallAutoText` (`:64`). Keep that reference so `settings.test.ts` invariants hold; the catalog `missed_call.autotext` default references the SAME `DEFAULT_MISSED_CALL_AUTOTEXT`.
- All six are already `export`ed and importable from `app/src/messages/` (same package, relative import).

---

## 3. Send-sites to reroute (spec §5)

| # | file:line | current call/literal | becomes |
|---|---|---|---|
| 1 | `jobs/tourReminders.ts:290` | `const body = REMINDER_BODIES[row.kind];` (1:1 route) | `const body = resolveMessage(\`tour.${row.kind}\`);` — then delete `REMINDER_BODIES` (`:48-54`) |
| 2 | `jobs/tourReminders.ts:432` | `const body = REMINDER_BODIES[row.kind];` (group route) | same resolver call |
| 3 | `jobs/placementNudges.ts:381` | `body: rung.body,` (in `sendMessageService` call) | `body: resolveMessage(\`nudge.${rung.kind}\`)` — drop the `body:` field from `NUDGE_RUNGS` entries (keep `kind`/`recipient`/`delayMs`) |
| 4 | `jobs/relayFanOut.ts:485` | `const body = composeIntroBody(roster.map((m) => m.name));` | keep `composeIntroBody` but have it (or the caller) call `resolveMessage('relay.intro', { members: connection })`; drop the `RELAY_INTRO_IDENTITY` concat at `:181` (now inside the default) |
| 5 | `routes/public.ts:272-283` | manual `getOrgSettings()` read + `renderWelcome(template, firstName)` where `template = WELCOME_TEXT_TEMPLATE`/`s.welcomeText` | `resolveWithSettings('welcome.sms', { firstName })` (replaces the manual settings read + `renderWelcome`). NOTE `WELCOME_TEXT_TEMPLATE` (`:54`) is re-exported for importers; keep the export as an alias or repoint importers. |
| 6 | `jobs/missedCallAutoText.ts:126-130` | `body: orgSettings.missedCallAutoText` | `body: await resolveWithSettings('missed_call.autotext')` — still gated by `orgSettings.missedCallAutoTextEnabled` (`:111`, unchanged; the enabled read still needs `getOrgSettings()`) |
| 7 | `routes/webhooks/twilio.ts:697` | `keywordReply = optedOut ? STOP_CONFIRMATION : WELCOME_SMS;` | STOP → `resolveMessage('keyword.stop')`; the opt-in/START reply → **`await resolveWithSettings('welcome.sms')`** (§7 INTENTIONAL BEHAVIOR CHANGE — START now honors the `welcomeText` override, matching the housing-fair path; today it uses the raw `WELCOME_SMS` const) |
| 8 | `routes/webhooks/twilio.ts:634` | `keywordReply = HELP_REPLY;` | `resolveMessage('keyword.help')` |
| 9 | `routes/webhooks/voice.ts` (12 sites in §1.4) | each `<Say>`/`maskedSayHangup` literal | `resolveMessage('voice.…', {…})`, wrapper unchanged |
| 10 | `routes/voiceApi.ts:237` | `renderCellVerifySms(code)` | leave call as-is if `renderCellVerifySms` becomes a thin wrapper over `resolveMessage('verify.cell_code', { code })` |
| 11 | `lib/smsCompliance.ts` | — | change NOTHING; the catalog imports its constants |

### Preview / echo sites (spec §5 tail) — repoint to the SAME catalog so preview == sent
| file:line | current | becomes |
|---|---|---|
| `routes/tourReminders.ts:109` | `body: REMINDER_BODIES[row.kind],` (imports `REMINDER_BODIES` at `:24`) | `body: resolveMessage(\`tour.${row.kind}\`)` |
| `routes/contactTimeline.ts:612` | `body: REMINDER_BODIES[row.kind],` (imports at `:68`) | `body: resolveMessage(\`tour.${row.kind}\`)` |
| `routes/contactTimeline.ts:230-234` | `NUDGE_RUNG_BY_KIND` map built from `NUDGE_RUNGS` reading `rung.body` (`:234`) | since `body` leaves `NUDGE_RUNGS`, rebuild this map's `body` from `resolveMessage(\`nudge.${rung.kind}\`)` (keep `stage`/`recipient` from `NUDGE_RUNGS`). **This is the placement-nudge preview echo the spec's "~467" pointer refers to — it is now at `:230-234` + the map is consumed later in the gather.** |

---

## 4. Tests — repoint vs keep-verbatim (spec §6)

### 4.1 REPOINT to the catalog (delete the hand-maintained drift-alarm literal)
For each, quote the current pinned literal so the implementer knows what to replace:

- **`e2e/scenarios/steps.ts:114-120`** — `export const TOUR_REMINDER_BODIES` re-declares all 5 tour bodies verbatim (double-quoted; en_route is `"[AUTO] Your tour is coming up soon. Text us when you're on the way!"`). Consumed at `:1578`, `:1603`. → import from the catalog.
- **`e2e/tests/scenarios/scheduled-visibility.spec.ts`** — imports `TOUR_REMINDER_BODIES` (`:27`), uses `.day_before` at `:120,128,176,181`. Follows steps.ts automatically once that repoints.
- **`e2e/tests/scenarios/post-tour-application.spec.ts:38-41`** — pins nudge SUBSTRINGS: `RECEIPT_NUDGE = 'did the rental application come through'`, `COMPLETION_NUDGE = 'How is the application coming along'`, `APPROVAL_NUDGE = 'any decision yet on the application'`, `RTA_CLOSING_NUDGE = 'the 48-hour RTA window is closing'`. → derive from catalog `nudge.*` defaults.
- **`app/test/contactTimeline.test.ts:574`** — `const APPROVAL_BODY = '[AUTO] Checking in — any decision yet on the application we sent over?';` → import catalog `nudge.approval_check`.
- **`app/test/tourReminders.test.ts`** — verbatim tour bodies at `:207` (`"[AUTO] Your tour is confirmed. We'll send reminders as it approaches."`), `:208` (`'[AUTO] Reminder: your property tour is tomorrow.'`), `:527` (`CONFIRMATION_BODY = "[AUTO] Your tour is confirmed. We'll send reminders as it approaches."`, used at `:686,811`). → reference catalog `tour.*`.
- **`app/test/devGating.test.ts:416`** — `'[AUTO] Just checking in — did the rental application come through? Let us know if you need it re-sent.'` (receipt body). → catalog `nudge.receipt_check`.
- **`app/test/founderTriage.test.ts`** — voice SUBSTRING asserts: `:272` `'different line'` (self_call), `:290` `'send us a text message'` (greeting_no_holder), `:365` `'Press 1 to accept'` + `:366` `.not.toContain('reach the team')` (whisper_founder), `:485,550` `'Sorry we missed your call'` (missed_call_goodbye). These are `.toContain` substrings that survive a byte-identical move, but spec §6 says repoint → import the catalog voice defaults and assert against them.
- **`app/test/relayFanOut.test.ts`** — `composeIntroBody` behavior: `:391-395` (name-join / count logic — KEEP, that logic stays in code) and `:402` `expect(body.startsWith('Tenant Place LLC. Reply STOP to opt out.')).toBe(true);` (the identity prefix). → the prefix assertion should reference `RELAY_INTRO_IDENTITY` / catalog `relay.identity`, not the literal.
- **`app/test/cellVerification.test.ts:36-43`** — asserts `renderCellVerifySms('427193')` `.toContain('427193')` and `.toContain('HousingChoice')` + 10-minute expiry. Substring-based; keep the calls but they now exercise the wrapper → the catalog. Reference catalog `verify.cell_code` where it asserts full copy.

### 4.2 KEEP VERBATIM (independent legal spec anchors — must break loudly)
- **`app/test/smsCompliance.test.ts`** — pins every filed compliance string against the spec, e.g. `:105` the full `DEFAULT_MISSED_CALL_AUTOTEXT` (`"Tenant Place LLC: Sorry we missed your call! ... Reply STOP to opt out."`). LEAVE VERBATIM.
- **`e2e/tests/dashboard-next/a2p-compliance.spec.ts`** — re-declares the A2P copy as LOCAL consts (`:17,33` note "VERBATIM mirror"; it does NOT import app source), asserts against the UI. Uses `SMS_BRAND_NAME` local const + `missedCallAutoText` literals at `:616,631`. LEAVE VERBATIM.
- **`dashboard/src/routes/public/IntakeForm.test.tsx`** — asserts the exact CTIA disclosure label. LEAVE VERBATIM.

---

## 5. Cross-stack drift-guard (spec §9)

`dashboard/src/lib/consentCopy.ts` hand-mirrors the app's compliance consts. The names DIFFER across the two trees — the guard must map them:

| concept | app (`app/src/lib/smsCompliance.ts`) | dashboard (`dashboard/src/lib/consentCopy.ts`) |
|---|---|---|
| brand | `SMS_BRAND_NAME` `:24` = `Tenant Place LLC` | `SMS_BRAND` `:14` = `Tenant Place LLC` |
| web-form consent copy | `WEB_FORM_CONSENT_COPY` `:140` | `WEB_FORM_CONSENT_LABEL` `:32-36` (note: dashboard is a `+`-concatenated string; app inlines `${SMS_BRAND_NAME}`) |
| consent version | `CONSENT_VERSION` `:81` = `ctia-2026-06` | `CONSENT_VERSION` `:18` = `ctia-2026-06` |
| privacy url | `PRIVACY_POLICY_URL` `:28` | `PRIVACY_POLICY_URL` `:21` |
| terms url | `TERMS_URL` `:29` | `TERMS_URL` `:22` |
| human consent methods | `HUMAN_CONSENT_METHODS` `:71-77` (a `ReadonlySet`) | `HUMAN_CONSENT_METHODS` `:43-49` (a `readonly` array — SAME 5 values, SAME order) |

> Spec §9 names "five consent constants" but there are effectively SIX shared concepts (brand + web-form + version + 2 URLs + human-methods). The guard should assert all overlapping ones. Watch the SHAPE mismatch on `HUMAN_CONSENT_METHODS` (Set vs array) — compare `[...appSet]` against the dashboard array; and `WEB_FORM_CONSENT_COPY` interpolates `${SMS_BRAND_NAME}` while the dashboard hardcodes `Tenant Place LLC`, so compare resolved string values.

**Recommended location: the `e2e` workspace** (`e2e/tests/…` or a small `e2e/tests/unit/consent-drift.spec.ts`), run under its Playwright/tsx loader.
- Rationale: e2e is the ONLY workspace whose tsconfig (`allowJs`, extends base, no `rootDir:src` clamp) and loader can pull TS from BOTH `../../app/src/...` and `../../dashboard/src/...` at runtime. `app`'s own tsconfig pins `rootDir:"src"` / `include:["src"]`, so an app-side test importing dashboard source would violate rootDir; `dashboard` (Vite) can't import app's NodeNext `.js`-specifier ESM cleanly either.
- **Caveat (real friction, evidenced):** `a2p-compliance.spec.ts` deliberately HAND-MIRRORS the app consts rather than importing them — a hint that importing app's `.js`-extension ESM specifiers under Playwright's loader was found awkward. If a direct `import { … } from '../../app/src/lib/smsCompliance.js'` fails to resolve, the least-brittle fallback is a tiny **`scripts/check-consent-drift.mjs`** node comparator (the `scripts/` dir already hosts cross-cutting `.mjs` helpers and can `import()` both files by path via esbuild/tsx) wired into an npm script + CI. Document whichever is chosen. Root vitest is a third option but no root `vitest.config` exists today (only per-workspace), so it is the most setup.

---

## 6. Pre-ring Web Push decision (spec §4.4)

Site: `app/src/routes/webhooks/voice.ts:655-661` (`sendPreRingPush`):
```
const payload = {
  title: 'Incoming call',
  body: `Incoming call — ${callerLabel}`,
  kind: 'pre_ring' as const,
  callId: callSid,
  conversationId,
};
```
Two literals: `title` = `Incoming call`, `body` = `Incoming call — {callerLabel}` (interpolates the masked `callerLabel`, or the caller phone for an unknown caller via `pushCallerLabel`).

**RECOMMENDATION: LEAVE IN PLACE (do NOT add `push.incoming_call` this pass).** Reasons:
1. It is a **push notification**, not sent SMS/voice copy — the `MessageDef.channel` union is `'sms' | 'voice'` only (spec §3.1). Adding a `push` entry means widening the channel union AND the payload has TWO fields (`title` + `body`), so it does not fit the single-`default`-string shape without either a second catalog entry or a compound convention. That is exactly the "not trivially clean" case the spec says to leave in place.
2. It has no operator-editability need and no drift-alarm test pinning it (no test references `Incoming call —`), so centralizing buys nothing here.
3. Keeping it avoids polluting the `MessageClass`/`channel` types with a one-off. Note the decision in the spec-conformance review (as spec §4.4 instructs).

---

## 7. Spec gaps / drift since the spec was written

1. **`app/test/placementNudges.test.ts` is MISSING from spec §6.** It imports `NUDGE_RUNGS` (`:40`) and asserts `send.sent[0]!.body).toBe(NUDGE_RUNGS.awaiting_receipt!.body)` (`:327`), `.awaiting_approval!.body` (`:363,473`). Since the plan DELETES the `body:` field from `NUDGE_RUNGS` (§3 row 3), `NUDGE_RUNGS.<stage>!.body` will no longer exist → **these three assertions break the build**. Must repoint to `resolveMessage('nudge.<kind>')`. High-priority add to the §6 repoint list.

2. **`app/test/voiceOutbound.test.ts:276` is MISSING from spec §6.** Asserts `xml.toContain('Press 1 to connect')` — the `voice.whisper_outbound` copy. Substring, survives a byte-identical move, but for consistency should reference the catalog `voice.whisper_outbound` default. (Also `:390-435` reference "we missed your call" only in comments — no literal pin.)

3. **`voice.caller_label_default` is not a `<Say>` literal** — it is the `q['callerLabel'] ?? 'a Housing Choice contact'` default (`voice.ts:997`). The spec lists it as a voice id; flagging that its migration is a plain default-value read, not a resolver-wrapped send (see §1.4 note).

4. **Preview-site line drift:** spec says `services/contactTimeline.ts ~467` but the file is `routes/contactTimeline.ts` and the tour-reminder echo is at `:612`, the nudge-body echo (`NUDGE_RUNG_BY_KIND`) at `:230-234`. spec `routes/tourReminders.ts ~109` is accurate (`:109`). Both must repoint (§3).

5. **`routes/public.ts` re-exports `WELCOME_TEXT_TEMPLATE`** (`:54`) and defines a local `renderWelcome` (`:58-60`). The spec's §5 "replaces the manual settings-read + `renderWelcome`" is correct, but note `WELCOME_TEXT_TEMPLATE` is a PUBLIC re-export — check for external importers before deleting (keep as an alias to `WELCOME_SMS` or repoint importers). `renderWelcome` uses `.replace('{firstName}', firstName)` — single-token replace, matching the resolver's `{token}` convention.

6. **`smsCompliance.ts` also exports `OPT_IN_KEYWORDS`/`OPT_OUT_KEYWORDS`** (used at `twilio.ts:605-606`) — these are keyword SETS, not message copy, and correctly stay OUT of the catalog (not in scope). Noted so they're not mistaken for catalog entries.

7. **False-positive body matches (NOT catalog entries — leave alone):** `e2e/tests/scenarios/tenant-onboarding.spec.ts:59` "That one is no longer available…" and `public-pages.spec.ts` "no longer available" heading are the unit-listing-unavailable flow, unrelated to the voice `thread_closed`/`masked_refuse` copy. `a2p-compliance.spec.ts:616` `'Sorry we missed your call! Text us back.'` is a TEST-supplied override value, not a pinned default.

---

## Appendix — new catalog files (spec §3)
- `app/src/messages/catalog.ts` — `MessageId` union + `MESSAGE_CATALOG`, importing the 6 compliance consts from `../lib/smsCompliance.js`.
- `app/src/messages/resolve.ts` — `resolveMessage`, `resolveWithSettings`, `settingsToOverrides`.
- `app/src/messages/index.ts` — re-exports.
- New tests: `app/test/messages/catalog.test.ts`, `app/test/messages/resolve.test.ts` (spec §6).
