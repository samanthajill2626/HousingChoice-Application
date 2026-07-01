<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-01).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# A2P / SMS compliance hardening — design

**Date:** 2026-06-30 · **Status:** design (ready for implementation plan)
**Related:** `docs/issues/a2p-compliance-hardening.md`,
`docs/a2p/campaign-resubmission.md` (founder re-file hand-off),
`docs/issues/voice-do-not-call.md` + `docs/issues/call-recording-consent.md`
(voice — SEPARATE spec).

## 1. Why

A2P is approved. A four-way audit (2026-06-30) found the suppression side is
solid — we never text an opted-out number (dual-layer `sms_opt_out` + a pre-send
guard on every path: 1:1, broadcast, relay; provider 21610/30005-6 handled). The
gaps are at the **front of the lifecycle**: we capture people without a documented
opt-in, our first messages don't identify us or say how to opt out, and our code
diverges from the *approved* campaign (brand, keywords, embedded links, opt-in
flow). Rather than degrade the product, the **campaign is being re-filed** to match
the app (founder hand-off doc above). **This spec is the app-side work** that makes
the app both compliant and truthful to the re-filed campaign.

**Message classification (deliberate, per founder 2026-06-30):** our texts are
**informational / transactional** — helping a voucher-holder find and act on
housing they asked about — **not marketing**. This is the basis on which *verbal*
consent is acceptable (oral consent suffices for non-marketing messaging). If the
program ever adds promotional blasts, revisit: marketing requires express *written*
consent.

**Brand dependency:** the registered A2P brand is **Tenant Place LLC** (domain
`tenant.place`). All SMS-facing copy in this spec uses "Tenant Place LLC". If the
founder elects to text as "HousingChoice" instead, it must be a registered DBA
(founder decision, see re-file doc §5); the app copy then follows that choice. The
internal/dashboard name stays "HousingChoice" regardless.

## 2. Consent data model

Add to the contact item (`app/src/repos/contactsRepo.ts`) — all optional so a
fast add stays fast:

| Field | Type | Notes |
|---|---|---|
| `consent_method` | enum | `web_form` \| `inbound_text` \| `verbal_phone` \| `verbal_in_person` \| `paper_form` \| `imported` |
| `consent_at` | ISO 8601 | When consent was obtained (may differ from `created_at`) |
| `consent_version` | string | The disclosure version shown (web form), e.g. `ctia-2026-06`; null for non-form methods |
| `consent_note` | string | Optional free-text ("said OK to texts at fair") |
| `consent_captured_by` | string | Actor userId when staff-entered (form/inbound = system) |

**Derivation — "has SMS consent":** any non-empty `consent_method`. This is the
single predicate the JIT gate and broadcast filter read. `web_form` and
`inbound_text` are stamped automatically; the other four are only ever set by a
human (contact-create field or JIT modal).

Supersedes the ad-hoc `capture_source` values (`housing_fair`/`flyer`/`inbound_sms`)
for consent purposes — keep `capture_source` for provenance/analytics, but consent
is judged off `consent_method`. Backfill: existing contacts with
`capture_source='inbound_sms'` → `consent_method='inbound_text'`;
`housing_fair`/`flyer` → `web_form` (they came through the public form). One-time,
idempotent.

## 3. Capture points

Four ways `consent_method` gets set; two automatic, two human:

1. **Public intake form (`web_form`, automatic).** A **required, unchecked-by-
   default** consent checkbox gates submit (client AND server). Copy (Full CTIA):
   > ☐ I agree to receive recurring texts from Tenant Place LLC about new
   > properties that accept my voucher, tour reminders, and updates. Message
   > frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for
   > help. See our Privacy Policy and Terms.
   Links go to `tenant.place/privacypolicy` and `tenant.place/terms`. On submit,
   stamp `consent_method='web_form'`, `consent_at=now`, `consent_version`. The
   server **rejects** a submit missing the checkbox (never silently accepts).
   **GUARDRAIL:** loud `do-not-remove — A2P/CTIA consent gate` comments on both the
   form field and the server validation.

2. **Inbound text (`inbound_text`, automatic).** Existing inbound auto-capture
   (`app/src/services/contactCapture.ts`) stamps `consent_method='inbound_text'` +
   `consent_at`. Customer-initiated contact is the consent basis (informational).
   Unchanged behavior otherwise — 1:1 conversation proceeds.

3. **Contact-create form (human, OPTIONAL).** An optional "Consent to text"
   section on the add-contact form: method dropdown (the four human values), a
   `when` date (default today), and an optional note. Left blank → nothing stamped
   (the JIT gate catches it later). When filled, stamp the fields +
   `consent_captured_by`.

4. **Just-in-time gate (human, HARD BLOCK).** When staff sends the **first
   proactive 1:1 text** to a contact with **no** `consent_method`, block the send
   with a modal capturing method + when + optional note. On confirm: stamp consent,
   then send. **Scope:** the gate fires only for a *proactive* first outbound to a
   no-consent contact. Replying inside a conversation the contact started is always
   allowed (they're `inbound_text` anyway). "Cancel" aborts the send.

## 4. Broadcasts — surface, don't silently drop

A broadcast can't pop a modal mid-fan-out. So no-consent recipients are:
- **Excluded** from the send (fenced alongside the existing opt-out/unreachable
  fences in `app/src/jobs/broadcastFanOut.ts`), and
- **Surfaced** in the composer's `RecipientPreview` (the editable list we already
  built) with a clear "consent not recorded — fix before sending" treatment + a
  count, so staff can resolve them (record consent → they re-enter the audience).

## 5. Outbound message content

- **First-contact templates get identity + opt-out.**
  - Housing-fair welcome (`app/src/routes/public.ts` default + `settingsRepo`):
    use the filed welcome copy — *"Welcome to Tenant Place LLC! You're signed up
    for new properties that accept your voucher, plus tour reminders and updates.
    Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe,
    HELP for help."*
  - Missed-call auto-text (`settingsRepo` default): add business name + "Reply STOP
    to opt out." (currently has neither).
- **Template validation floor.** The settings PUT rejects (or hard-warns) a
  first-contact template edit that drops the opt-out language, so an admin can't
  strip compliance copy. **GUARDRAIL** comment explaining why.
- **Relay intro** (`app/src/jobs/relayFanOut.ts`): prepend business identity + a
  "Reply STOP to opt out" to the group intro (today it has neither).
- **Brand:** all SMS-facing copy → "Tenant Place LLC" (per §1 brand dependency).

## 6. Self-managed STOP / HELP / START

We manage keyword replies ourselves (uniform across 1:1 + relay; single source of
truth in our DB). **Twilio Advanced Opt-Out auto-reply must be OFF** on the
Messaging Service so recipients don't get double confirmations (operator step).

- **Keyword sets** (match the filed campaign):
  - Opt-out: `OPTOUT, CANCEL, END, QUIT, UNSUBSCRIBE, REVOKE, STOP, STOPALL`
    (add OPTOUT + REVOKE to the current set).
  - Opt-in: `START, JOIN, HOME, YES` (add JOIN + HOME; keep the harmless UNSTOP).
- **STOP** → set suppression (unchanged) + send filed confirmation: *"You have
  successfully been unsubscribed. You will not receive any more messages from this
  number. Reply START to resubscribe."*
- **HELP** → filed help copy, **no phone number in the body** (campaign declares
  phone-numbers = No): *"Tenant Place LLC: housing listing alerts for voucher
  holders. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.
  More info: tenant.place."*
- **START / JOIN / HOME / YES** → clear suppression; if the contact had no
  `consent_method`, stamp one (`inbound_text`) + send the welcome (keyword opt-in
  is a documented affirmative opt-in).

## 7. Out of scope (tracked elsewhere)

- **Voice** (in-app masked outbound calling, `voice_opt_out`, recording) — its own
  spec; see `docs/issues/voice-do-not-call.md`.
- **The campaign re-file itself** — founder action, `docs/a2p/campaign-resubmission.md`.
- **Automated National DNC scrubbing** — deferred (voice track).
- **Consent report/export** (`/api/contacts/consent-report`) — P2 fast-follow; nice
  for carrier audits, not go-live-blocking.

## 8. Testing (e2e + unit)

- Public form: submit without the checkbox is **rejected** (server); with it,
  `consent_method='web_form'` + version stamped.
- JIT gate: first proactive text to a no-consent contact **blocks**; recording
  consent then sends; a reply in a contact-started conversation does **not** block.
- Broadcast: no-consent recipients excluded + surfaced with a count; recording
  consent re-includes them.
- Keywords: each opt-out/opt-in keyword honored; STOP confirmation + HELP replies
  match filed copy; HELP body contains no phone number.
- Template validation: dropping opt-out language from a first-contact template is
  rejected.

## 9. Rollout / dependencies

1. Founder confirms brand (§1) — copy strings follow.
2. Founder re-files the campaign (links=Yes may trigger re-vetting → gates live SMS).
3. ~~Twilio Advanced Opt-Out auto-reply OFF~~ — **confirmed OFF 2026-07-01.**
   `SMS_SENDING_ENABLED` stays the go-live switch.
4. Ship app changes → verify via e2e → flip `SMS_SENDING_ENABLED=true` after the
   re-filed campaign is approved.
