# Message Catalog — single source of truth for automated copy

**Date:** 2026-07-03
**Status:** Approved design, ready for implementation
**Branch:** `feat/message-catalog` (worktree `w:/tmp/message-catalog`)
**Author:** Claude (brainstormed with Cameron)

---

## 1. Problem

Every automated/pinned message the system sends — tour reminders, placement
nudges, the housing-fair welcome, the missed-call auto-text, the relay group
intro, voice `<Say>` prompts, the cell-verification code SMS, and the A2P
keyword replies — is **hard-coded in disparate places**. There is no single
place to see, or a uniform way to resolve, "the text we send."

A partial override mechanism already exists (`OrgSettings` in DynamoDB, read at
send-time via `getOrgSettings()`), but only **three** messages are wired into
it: `welcomeText`, `missedCallAutoText`, and `quickReplies`. Everything else is
a bare constant in a job/route file, with **no** override path. Worse, the copy
is **duplicated** across the codebase — send-time bodies vs. verbatim test
copies (~13 test files) vs. seed data vs. a hand-mirrored dashboard copy of the
consent strings — each pair a silent drift hazard guarded only by convention.

## 2. Goal & non-goals

**Goal.** Consolidate every automated message *default* into one catalog module
(the single source of truth), and route every send-site through one resolver so
that:
- there is exactly one place a default string lives (or, for compliance copy,
  one place it is authoritatively referenced from);
- the resolver is **generic enough** that any message *can* be made
  operator-editable later with a small diff;
- the three currently-editable messages keep working **unchanged**.

**Non-goals (this pass).**
- **No new editable fields in the Settings UI.** The dashboard Settings surface
  is untouched. We build the generic *resolver shape*, but we do **not** add the
  `messageOverrides` storage field or any writer/validator/UI for it — that is
  inseparable from the future generic Templates UI and is captured as a filed
  issue (§10).
- **No shared cross-package module** and **no runtime API for consent copy** —
  see §9 for why, and the filed issue.
- No wording changes. Every string ships byte-identical to today (except where
  §7 folds a currently-concatenated prefix into the string, which produces the
  same sent text).

## 3. Chosen architecture (Approach 1)

A **catalog module** holds every message as data; a **pure resolver** picks an
override-or-default and interpolates; send-sites call the resolver.

```
app/src/messages/
  catalog.ts    — MESSAGE_CATALOG: Record<MessageId, MessageDef>  (the registry)
  resolve.ts    — resolveMessage(), resolveWithSettings(), settingsToOverrides()
  index.ts      — re-exports
```

### 3.1 The catalog

```ts
export type MessageClass = 'operational' | 'compliance-locked' | 'voice' | 'transactional';

export interface MessageDef {
  id: MessageId;             // stable key, e.g. 'tour.day_before' — also the future override key
  default: string;           // canonical copy, with {token} placeholders where it interpolates
  class: MessageClass;
  editable: boolean;         // may an operator override it later? (see table)
  channel: 'sms' | 'voice';
  vars: readonly string[];   // allowed interpolation tokens, e.g. ['firstName'], ['callerLabel']
  requiresOptOut?: boolean;  // first-contact compliance floor: an override must contain "STOP"
  maxChars?: number;         // segment cap for future validation (default 320 for sms)
}

export const MESSAGE_CATALOG: Record<MessageId, MessageDef> = { /* … */ };
```

`MessageId` is a string-literal union of every id below. The catalog is a
**pure** module: data + type only, no I/O, no repo imports (same discipline as
`smsCompliance.ts`).

**Where each `default` comes from:**
- **Operational / voice / transactional** entries hold the literal string,
  **moved out of** the job/route file it lives in today (that file no longer
  declares the constant — it calls the resolver).
- **`compliance-locked`** entries and the two compliance-derived editable
  defaults (`welcome.sms`, `missed_call.autotext`) and the relay identity
  **reference the existing `smsCompliance.ts` constants** by import — those
  strings must remain single-sourced in the A2P compliance module (which is
  deliberately "the single source of truth for A2P/SMS/CTIA compliance … and
  NOWHERE else"). The catalog is the unified *registry*; `smsCompliance.ts`
  stays the authoritative *home* for filed copy. No duplication either way.

### 3.2 The resolver

```ts
// pure — no I/O
export function resolveMessage(
  id: MessageId,
  vars?: Record<string, string>,
  overrides?: Partial<Record<MessageId, string>>,
): string;

// async convenience — reads settings defensively, adapts, resolves
export async function resolveWithSettings(id: MessageId, vars?: Record<string, string>): Promise<string>;

// adapter: OrgSettings → the generic override map (today maps only the legacy 3)
export function settingsToOverrides(s: OrgSettings): Partial<Record<MessageId, string>>;
```

`resolveMessage` logic: `const def = MESSAGE_CATALOG[id]; const override =
def.editable ? overrides?.[id] : undefined; const template = (typeof override
=== 'string' && override.length > 0) ? override : def.default; return
interpolate(template, vars, def.vars);`

- **Interpolation** is `{token}` replacement (single braces — matches the
  existing `renderWelcome` `{firstName}` convention). `interpolate` substitutes
  each `def.vars` token from `vars`; a missing var is a defect the tests catch
  (never silently blank for a declared token). Tokens NOT in `def.vars` are left
  untouched. (Broadcast merge-fields use `[Bracket]` syntax in a different
  subsystem — out of scope, unchanged.)
- **Defensive fallback:** `resolveWithSettings` wraps `getOrgSettings()` in
  try/catch and falls back to `{}` overrides (→ catalog default) on any read
  failure — exactly today's behavior for `welcomeText`/quick-replies. A
  settings-read failure must never break a send.

### 3.3 The override map — generic but dormant

`resolveMessage` **accepts** a generic `Partial<Record<MessageId, string>>`, so
future editability is a small diff. But this pass does **not** add a
`messageOverrides` field to `OrgSettings`. Instead, `settingsToOverrides(s)`
maps only the **legacy three**:

```ts
{
  ...(s.welcomeText ? { 'welcome.sms': s.welcomeText } : {}),
  ...(s.missedCallAutoText ? { 'missed_call.autotext': s.missedCallAutoText } : {}),
  // quickReplies is list-typed — NOT a catalog message; stays on OrgSettings, read as today
}
```

So the three editable messages resolve through the same path (their overrides
honored), and every newly-centralized message resolves to its catalog default
(no override path yet — matching "no new editable fields now"). The day the
generic Templates UI lands, the work is: add `messageOverrides` to `OrgSettings`
+ a validated writer + UI, and spread it into `settingsToOverrides` — one place
(§10 issue).

## 4. The message inventory (ids, classes, defaults)

All defaults are byte-identical to today unless a §7 note applies. Line refs are
where the literal lives **now** (to be moved/referenced).

### 4.1 Operational — `class: 'operational'`, `channel: 'sms'`, `editable: true`, no opt-out floor

| id | from | vars | notes |
|---|---|---|---|
| `tour.confirmation` | `jobs/tourReminders.ts` REMINDER_BODIES.confirmation | — | `[AUTO]` baked in |
| `tour.day_before` | REMINDER_BODIES.day_before | — | |
| `tour.morning_of` | REMINDER_BODIES.morning_of | — | |
| `tour.en_route` | REMINDER_BODIES.en_route | — | |
| `tour.no_show_checkin` | REMINDER_BODIES.no_show_checkin | — | |
| `nudge.receipt_check` | `jobs/placementNudges.ts` NUDGE_RUNGS awaiting_receipt.body | — | tenant |
| `nudge.completion_check` | NUDGE_RUNGS awaiting_completion.body | — | tenant |
| `nudge.approval_check` | NUDGE_RUNGS awaiting_approval.body | — | landlord |
| `nudge.rta_window_closing` | NUDGE_RUNGS awaiting_landlord_submission.body | — | landlord |
| `relay.intro` | `jobs/relayFanOut.ts` composeIntroBody | `members` | **§7:** identity prefix folded in; `{members}` covers the name-list / neutral-count variants (keep the count-plurality logic in code, feeding `members`) |

> `editable: true` marks these as *eligible* for a future Templates field; it
> does **not** expose them now (no override map, no UI).

### 4.2 Compliance-derived, already editable — `editable: true`

| id | default source | class | vars | floor |
|---|---|---|---|---|
| `welcome.sms` | `smsCompliance.ts` `WELCOME_SMS` | operational | `firstName` | `requiresOptOut: true` |
| `missed_call.autotext` | `settingsRepo` default = `DEFAULT_MISSED_CALL_AUTOTEXT` | operational | — | `requiresOptOut: true` |

- `welcome.sms` keeps `{firstName}` interpolation (today's `renderWelcome`).
- `missed_call.autotext`: the catalog's `default` references
  `DEFAULT_MISSED_CALL_AUTOTEXT`; `settingsRepo.DEFAULT_ORG_SETTINGS.missedCallAutoText`
  keeps pointing at the same constant so `settings.test.ts` invariants hold.

### 4.3 Compliance-locked — `class: 'compliance-locked'`, `editable: false`

Present in the catalog (so the registry is complete) but **never** freely
editable; `default` references the `smsCompliance.ts` constant.

| id | source | vars |
|---|---|---|
| `keyword.stop` | `STOP_CONFIRMATION` | — |
| `keyword.help` | `HELP_REPLY` | — |
| `consent.web_form` | `WEB_FORM_CONSENT_COPY` | — |
| `relay.identity` | `RELAY_INTRO_IDENTITY` | — (used as the prefix component of `relay.intro`) |

### 4.4 Voice — `class: 'voice'`, `channel: 'voice'`, `editable: false`

TwiML `<Say>` copy from `routes/webhooks/voice.ts`. Moves into the catalog;
`voice.ts` calls `resolveMessage('voice.…', { … })` and wraps the result in
TwiML. `{callerLabel}` / `{targetLabel}` are masked role/name labels (never a
phone).

| id | approx. line | vars |
|---|---|---|
| `voice.whisper_founder` | ~1026 | `callerLabel` |
| `voice.whisper_relay` | ~1027 | `callerLabel` |
| `voice.whisper_outbound` | ~976 | `targetLabel` |
| `voice.caller_label_default` | ~997 | — (the "a Housing Choice contact" fallback) |
| `voice.team_unreachable` | ~1176 | — |
| `voice.greeting_no_holder` | ~417 | — |
| `voice.self_call` | ~437 | — |
| `voice.founder_refuse` | ~476 | — (borderline/dead path — include, tag) |
| `voice.thread_closed` | ~740 | — |
| `voice.masked_refuse` | ~752 | — (borderline/dead) |
| `voice.outbound_unavailable` | ~960 | — |
| `voice.missed_call_goodbye` | ~1371 | — |

> The pre-ring **Web Push** payload (`voice.ts` ~657, "Incoming call — …") is a
> push notification, not sent copy. **Borderline:** include as
> `push.incoming_call` (`channel: 'sms'` is wrong; add it only if trivially
> clean — otherwise leave in place and note in the spec-conformance review). The
> implementer decides based on how cleanly it factors; document the call.

### 4.5 Transactional — `class: 'transactional'`, `editable: false`

| id | source | vars |
|---|---|---|
| `verify.cell_code` | `lib/cellVerification.ts` `renderCellVerifySms` | `code` |

> Uses the internal name "HousingChoice" (not the SMS brand) — preserve verbatim.

### 4.6 Not catalog entries (stay as code)

- **`quickReplies`** — a list, not a single message. Its default array may move
  into the catalog as a plain exported const for tidiness, but its storage
  (`OrgSettings.quickReplies`) and read path are **unchanged**.
- **Relay per-message wrapping** `<SenderName>: <body>` (`relayFanOut.ts`
  composeRelayBody) — a formatting transform over arbitrary live user text, not
  a fixed template. Stays a function.

## 5. Send-site migration (behavior-preserving)

Each site swaps its literal for a resolver call; `[AUTO]` prefixes, recipients,
timing, and TwiML structure are all preserved.

| file | change |
|---|---|
| `jobs/tourReminders.ts` | delete `REMINDER_BODIES`; call `resolveMessage('tour.<kind>')` at the two read sites (~290, ~432) |
| `jobs/placementNudges.ts` | delete inline `body:` strings; `resolveMessage('nudge.<kind>')` at ~379 |
| `jobs/relayFanOut.ts` | `resolveMessage('relay.intro', { members })`; drop the `RELAY_INTRO_IDENTITY` concat (now inside the default) |
| `routes/public.ts` | welcome path → `resolveWithSettings('welcome.sms', { firstName })` (replaces the manual settings-read + `renderWelcome`) |
| `jobs/missedCallAutoText.ts` | body → `resolveWithSettings('missed_call.autotext')` (still gated by `missedCallAutoTextEnabled`) |
| `routes/webhooks/twilio.ts` | **§7 unify:** START/keyword reply → `resolveWithSettings('welcome.sms')` so it honors the `welcomeText` override (today it uses the raw constant); STOP reply → `resolveMessage('keyword.stop')`; HELP → `resolveMessage('keyword.help')` |
| `routes/webhooks/voice.ts` | each `<Say>` literal → `resolveMessage('voice.…', { … })`, still wrapped in TwiML |
| `lib/cellVerification.ts` | `renderCellVerifySms(code)` → `resolveMessage('verify.cell_code', { code })` (keep the export as a thin wrapper if callers depend on it) |
| `lib/smsCompliance.ts` | keeps its constants (still the compliance home) — the catalog imports them. Add nothing; change nothing legally-pinned. |

Contact-timeline **previews** that echo these bodies (`services/contactTimeline.ts`
~467, `routes/tourReminders.ts` ~109) must read the **same** resolver/catalog so
preview and sent text stay in lockstep (they already read the same constant
today — repoint to the catalog).

## 6. Tests — the drift-alarm win

Once a body lives in the catalog, **operational and voice tests import the
catalog** instead of pinning a verbatim literal — which *deletes* the
hand-maintained drift-alarm pairs. Update in lockstep:

- `e2e/scenarios/steps.ts` (`TOUR_REMINDER_BODIES`), `e2e/tests/scenarios/post-tour-application.spec.ts`,
  `e2e/tests/scenarios/scheduled-visibility.spec.ts` → reference the catalog.
- `app/test/contactTimeline.test.ts`, `tourReminders.test.ts`, `devGating.test.ts`,
  `founderTriage.test.ts`, `relayFanOut.test.ts`, `cellVerification.test.ts` →
  reference the catalog.

**Deliberately kept verbatim (do NOT auto-follow a code edit):** the
**compliance spec tests** — `app/test/smsCompliance.test.ts` and
`e2e/tests/dashboard-next/a2p-compliance.spec.ts`, and the dashboard's
`IntakeForm.test.tsx`. These assert the exact filed legal copy as an independent
spec anchor; they must break loudly if the copy ever changes. Leave them
verbatim.

New tests:
- `app/test/messages/catalog.test.ts` — every `MessageId` has a def; every
  `editable + requiresOptOut` default passes `templateHasOptOutLanguage`; every
  `{token}` in a default is declared in `vars` and vice-versa.
- `app/test/messages/resolve.test.ts` — override wins for `editable`, ignored
  for non-editable; interpolation substitutes declared tokens; missing settings
  → catalog default (no throw); `settingsToOverrides` maps the legacy 3.

## 7. Confirmed decisions (folded in above)

1. **Static text that goes out is part of the string**, not concatenated after
   the resolver. `[AUTO]`, the opt-out sentence, URLs, and the relay identity
   prefix live inside the `default`. The brand name stays sourced from the
   single `SMS_BRAND_NAME` const via the compliance strings the catalog imports
   (that const is a deliberate one-line point-of-change — do NOT hard-fork it
   per message). Only genuinely per-send values remain `{tokens}`.
2. **START/keyword reply unified:** `twilio.ts`'s START reply now honors the
   `welcomeText` override (via `resolveWithSettings('welcome.sms')`), matching
   the housing-fair path. This is the one intentional behavior change (a
   correctness improvement) — call it out in the review.

## 8. Storage / Settings UI — untouched

`OrgSettings`, its repo, the GET/PUT routes, the validators, and the dashboard
`TemplatesSection.tsx` are **unchanged**. The only settings-adjacent edit:
`settingsRepo.DEFAULT_ORG_SETTINGS.missedCallAutoText` and the GET route's
`welcomeTextDefault` continue to reference the same `smsCompliance.ts` constants
the catalog references, so `settings.test.ts` (`welcomeTextDefault === WELCOME_SMS`)
stays green. There is **no** `messageOverrides` field this pass.

## 9. Cross-package consent copy — verbatim-in-bundle + drift guard

`dashboard/src/lib/consentCopy.ts` hand-mirrors five constants from
`smsCompliance.ts` (`WEB_FORM_CONSENT_COPY`/`_LABEL`, `SMS_BRAND_NAME`/`SMS_BRAND`,
`CONSENT_VERSION`, `PRIVACY_POLICY_URL`, `TERMS_URL`, `HUMAN_CONSENT_METHODS`),
because the dashboard cannot import from `app/`. The top consumer is the
**public, unauthenticated** intake form (`dashboard/src/routes/public/IntakeForm.tsx`),
which renders the CTIA disclosure **verbatim at the moment of consent**.

**Decision:** keep the copy **verbatim in each bundle**. We rejected two
alternatives:
- **Runtime API** (dashboard fetches the copy from app): bad for legal copy on a
  public page — a failed/slow fetch means no disclosure or a bundled fallback,
  and a fallback *reintroduces the duplicate*; it also loses the verbatim ship
  guarantee. See the filed issue for the full reasoning.
- **Shared package now:** deferred — earns its keep only when the dashboard needs
  the whole catalog (the future Templates UI). See the filed issue.

**This pass adds a drift-guard test** asserting the app's five consent constants
`===` the dashboard's, placed in a workspace that can resolve both source trees
(the `e2e` workspace can; if resolution is awkward, a root `vitest` project or a
small `scripts/` comparator is acceptable — the implementer picks the least
brittle option and documents it). Each side already pins its own copy verbatim;
the gap is that nothing asserts the two sides *match* — this closes it.

## 10. Issues to file (in this branch)

1. **`docs/issues/message-catalog-legacy-override-migration.md`**
   (`type: improvement, severity: low, status: open`) — when the next
   settings-editable message is added: add a generic `messageOverrides:
   Record<MessageId, string>` to `OrgSettings` + a validated writer (enforcing
   each catalog entry's `requiresOptOut`/`maxChars`) + a generic Templates UI
   that iterates `editable` catalog entries; migrate `welcomeText` /
   `missedCallAutoText` (/`quickReplies`) into the map with a data migration and
   retire the legacy named fields; spread the map into `settingsToOverrides`.
   Note the shared-package (below) is the natural companion so the dashboard UI
   can read the catalog.

2. **`docs/issues/consent-copy-cross-stack-drift.md`**
   (`type: debt, severity: med, status: open`) — the five consent constants are
   hand-mirrored across `app`↔`dashboard`; guarded now by a drift-guard test but
   still duplicated. Records that runtime-API was considered and **rejected** for
   the public consent disclosure (legal copy must render deterministically), and
   names the **shared workspace package (option A)** as the eventual clean
   elimination: a zero-dependency package holding the catalog + pure resolver +
   consent consts, with its **own `tsc` build + `exports` map** (the friction is
   the app's compile-to-`dist`/run-under-Node prod path, not Vite), consumed by
   both stacks; do it when the generic Templates UI needs the catalog dashboard-side.

## 11. Verification plan

- `npm run test -w app` + `npm run test -w dashboard` (dashboard only lightly
  touched — the drift-guard test / any consentCopy comment).
- `npm run e2e` — full suite green (warm containers first: `npm run db:start &&
  npm run s3:start`; capture the real exit code, never `| tail`).
- Manual eyeball via `npm run e2e:session` + Playwright MCP is optional here
  (no UI change), but confirm at least one tour-reminder and one nudge send in
  the fake-phones outbox reads identically to before.

## 12. Risks

- **Missed a send-site or a test copy** → drift-alarm red or a stale literal.
  Mitigation: the audit inventory (§4) is the checklist; the new catalog tests
  assert token/floor invariants; the full e2e is the backstop.
- **Interpolation regression** (a `{token}` left unsubstituted, or double
  substitution) → visible garbage in a sent message. Mitigation:
  `resolve.test.ts` per-message token coverage; keep the exact same variables
  each site passes today.
- **Voice TwiML** — the `<Say>` content changes source but the TwiML wrapper must
  not; verify the voice specs (`founderTriage.test.ts`, any voice e2e) stay
  green.
- **Compliance copy accidentally moved** out of `smsCompliance.ts` → violates the
  A2P single-source guarantee. Mitigation: compliance-locked entries **import**,
  never re-literal; `smsCompliance.test.ts` stays verbatim.
