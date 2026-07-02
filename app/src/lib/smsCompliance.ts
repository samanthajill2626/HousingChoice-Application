// smsCompliance — the SINGLE SOURCE OF TRUTH for A2P/SMS/CTIA compliance.
//
// Everything that must stay truthful to the *approved (re-filed) A2P campaign*
// lives here and NOWHERE else, so brand, consent semantics, keyword sets, and
// every filed SMS copy string can never drift between routes/jobs/services.
// Phases 2 & 3 wire these into the webhook, broadcast fence, JIT gate, public
// intake form, settings validation, and relay intro — this Phase-1 module only
// DEFINES them.
//
// This module is deliberately PURE: no I/O, no repo imports, no env reads. It is
// importable everywhere (routes/jobs/services) and trivially unit-testable.
//
// Filed copy strings below are reproduced VERBATIM from the design spec
// (docs/superpowers/specs/2026-06-30-a2p-sms-compliance-design.md §3/§5/§6).
// Correctness of these strings is compliance-critical — smsCompliance.test.ts
// pins each one against the spec to guard against drift.

/**
 * The registered A2P brand name shown in all SMS-facing copy (spec §1).
 * If the founder switches to a registered DBA (e.g. "HousingChoice"), this ONE
 * line changes and every filed string below follows. The internal/dashboard
 * name stays "HousingChoice" regardless — do NOT use SMS_BRAND_NAME there.
 */
export const SMS_BRAND_NAME = 'Tenant Place LLC';

/** Public policy links embedded in the web-form consent copy (spec §3.1). The
 *  "Privacy Policy" and "Terms" words link to these. */
export const PRIVACY_POLICY_URL = 'https://tenant.place/privacypolicy';
export const TERMS_URL = 'https://tenant.place/terms';

// --- Consent model ---------------------------------------------------------

// MESSAGE CLASSIFICATION (spec §1, founder decision 2026-06-30): our texts are
// INFORMATIONAL / TRANSACTIONAL — helping a voucher-holder find and act on
// housing they asked about — NOT marketing. This classification is WHY *verbal*
// consent (verbal_phone / verbal_in_person) is acceptable: oral consent suffices
// for non-marketing messaging. If the program ever adds promotional blasts,
// revisit — marketing requires express WRITTEN consent.

/**
 * How a contact's SMS consent was obtained (spec §2 + client_inbound, added
 * 2026-07-02). Two methods are stamped AUTOMATICALLY by the system (web_form,
 * inbound_text); the rest are only ever set by a HUMAN (the contact-create form
 * or the just-in-time modal).
 */
export type ConsentMethod =
  | 'web_form'
  | 'inbound_text'
  | 'inbound_call'
  | 'client_inbound'
  | 'verbal_phone'
  | 'verbal_in_person'
  | 'paper_form'
  | 'imported';

/** Consent methods the SYSTEM stamps on its own: web form submit, inbound text,
 *  and inbound voice call (the caller reaching out IS the customer-initiated
 *  consent basis — same rationale as inbound_text, stamped by the voice webhook). */
export const AUTOMATIC_CONSENT_METHODS: ReadonlySet<ConsentMethod> = new Set<ConsentMethod>([
  'web_form',
  'inbound_text',
  'inbound_call',
]);

/** Consent methods that ONLY a human may set (contact-create field or JIT modal).
 *  `client_inbound` = staff attests the CLIENT reached out first (an inbound text
 *  or voice call). Distinct from the automatic `inbound_text`/`inbound_call`
 *  stamps: it covers HISTORICAL inbound contact nothing recorded at the time
 *  (predates the auto-stamping, or arrived on a since-merged number) — keeping
 *  system-stamped vs staff-attested provenance distinguishable in the audit trail. */
export const HUMAN_CONSENT_METHODS: ReadonlySet<ConsentMethod> = new Set<ConsentMethod>([
  'client_inbound',
  'verbal_phone',
  'verbal_in_person',
  'paper_form',
  'imported',
]);

/** The disclosure version shown on the public web form (spec §2/§3.1). Stamped
 *  as `consent_version` when consent is captured via the form. */
export const CONSENT_VERSION = 'ctia-2026-06';

/**
 * do-not-remove — A2P/CTIA consent gate.
 *
 * THE single predicate the JIT gate (first proactive 1:1) and the broadcast
 * fence read to decide "does this contact have SMS consent?". "Has consent" =
 * ANY non-empty `consent_method` (spec §2 derivation). Do not add ad-hoc consent
 * checks elsewhere — call this so the definition of consent lives in one place.
 */
export function hasSmsConsent(contact: { consent_method?: unknown }): boolean {
  return typeof contact.consent_method === 'string' && contact.consent_method.length > 0;
}

/**
 * Map a legacy `capture_source` to the consent method it implies (spec §2
 * backfill rule). Pure so the one-time backfill and its test share one mapping:
 *   - inbound_sms          → inbound_text (customer-initiated contact)
 *   - housing_fair / flyer → web_form     (both came through the public form)
 * Anything else → undefined (no consent can be inferred).
 */
export function consentMethodFromCaptureSource(
  source: string | undefined,
): ConsentMethod | undefined {
  switch (source) {
    case 'inbound_sms':
      return 'inbound_text';
    case 'housing_fair':
    case 'flyer':
      return 'web_form';
    default:
      return undefined;
  }
}

// --- Filed SMS copy (VERBATIM — spec §3/§5/§6) -----------------------------

/**
 * The housing-fair welcome SMS (spec §5). First-contact template: carries brand
 * identity + opt-out language. Sent after a documented opt-in (web form submit or
 * a keyword opt-in).
 */
export const WELCOME_SMS = `Welcome to ${SMS_BRAND_NAME}! You're signed up for new properties that accept your voucher, plus tour reminders and updates. Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help.`;

/** STOP confirmation (spec §6) — sent when a recipient opts out via a keyword. */
export const STOP_CONFIRMATION = `You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.`;

/**
 * HELP reply (spec §6). The campaign declares phone-numbers = No, so this body
 * carries NO phone number — only the "More info: tenant.place" domain. The unit
 * test asserts this body contains no digit.
 */
export const HELP_REPLY = `${SMS_BRAND_NAME}: housing listing alerts for voucher holders. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out. More info: tenant.place.`;

/**
 * The public web-form consent checkbox label (spec §3.1, Full CTIA). The words
 * "Privacy Policy" and "Terms" link to PRIVACY_POLICY_URL / TERMS_URL. This is
 * the disclosure whose version is CONSENT_VERSION.
 */
export const WEB_FORM_CONSENT_COPY = `I agree to receive recurring texts from ${SMS_BRAND_NAME} about new properties that accept my voucher, tour reminders, and updates. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. See our Privacy Policy and Terms.`;

/**
 * Compliant default for the missed-call auto-text (spec §5). Derived from the
 * existing settingsRepo DEFAULT_ORG_SETTINGS.missedCallAutoText by PREPENDING the
 * brand identity (`${SMS_BRAND_NAME}: `) and ensuring it ends with the opt-out
 * instruction (` Reply STOP to opt out.`). The helpful content of the existing
 * copy is preserved verbatim; only identity + opt-out are added. Phase 2 wires
 * this into settingsRepo — this module only DEFINES it (no settingsRepo edit).
 */
export const DEFAULT_MISSED_CALL_AUTOTEXT = `${SMS_BRAND_NAME}: Sorry we missed your call! To get started, please text us your full name, voucher size, and housing authority and we'll be right with you. Reply STOP to opt out.`;

/**
 * Business identity + opt-out string the relay job PREPENDS to the group intro
 * (spec §5). Phase 2 composes it in front of the existing intro copy; here we
 * only export the identity + opt-out prefix (today the intro has neither).
 */
export const RELAY_INTRO_IDENTITY = `${SMS_BRAND_NAME}. Reply STOP to opt out.`;

// --- Keyword sets (spec §6 — match the filed campaign) ---------------------
//
// These SUPERSEDE the inline STOP_KEYWORDS / START_KEYWORDS sets currently in
// app/src/routes/webhooks/twilio.ts. Phase 2 will import these instead. Values
// are uppercase; the webhook uppercases the inbound body before matching.

/**
 * Opt-out keywords (spec §6). Adds OPTOUT + REVOKE to the previous set
 * (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT).
 */
export const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set<string>([
  'OPTOUT',
  'CANCEL',
  'END',
  'QUIT',
  'UNSUBSCRIBE',
  'REVOKE',
  'STOP',
  'STOPALL',
]);

/**
 * Opt-in keywords (spec §6). Adds JOIN + HOME; keeps the harmless UNSTOP
 * alongside START / YES.
 */
export const OPT_IN_KEYWORDS: ReadonlySet<string> = new Set<string>([
  'START',
  'JOIN',
  'HOME',
  'YES',
  'UNSTOP',
]);

// --- Template-validation floor ---------------------------------------------

/**
 * do-not-remove — A2P/CTIA compliance floor.
 *
 * Returns true iff `text` still contains opt-out language (the standalone word
 * "STOP", e.g. "Reply STOP to opt out"). Phase 2's settings PUT calls this to
 * REJECT a first-contact template edit that strips the opt-out instruction — an
 * admin must never be able to remove compliance copy from a first-contact
 * template, or the app would text people with no documented way to opt out.
 */
export function templateHasOptOutLanguage(text: string): boolean {
  // Require the standalone word STOP (word boundaries so "STOPWATCH"/"NONSTOP"
  // don't count), case-insensitive — this is the CTIA opt-out instruction.
  return /\bSTOP\b/i.test(text);
}
