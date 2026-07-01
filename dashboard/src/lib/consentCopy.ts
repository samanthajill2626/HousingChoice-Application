// A2P / CTIA consent copy + human method labels — the dashboard's MIRROR of the
// app's app/src/lib/smsCompliance.ts. The dashboard is a separate package and
// CANNOT import from app/src, so the compliance-critical strings are duplicated
// here by hand. Keep the two in sync whenever the filed campaign copy changes.
//
// do-not-remove — A2P/CTIA consent copy (mirrors app/src/lib/smsCompliance.ts).
// This wording is FILED with the carrier campaign; reproduce it VERBATIM. The
// public web-form checkbox label below is the exact CTIA disclosure — do not
// paraphrase, reorder, or drop any sentence (Message frequency / rates / STOP /
// HELP / links).

/** The end-user-facing SMS brand (the registered A2P brand). NOT "HousingChoice"
 *  — that is the internal/dashboard name only. */
export const SMS_BRAND = 'Tenant Place LLC';

/** The public web-form consent-disclosure version stamped alongside `web_form`
 *  consent (mirrors the app's CONSENT_VERSION). */
export const CONSENT_VERSION = 'ctia-2026-06';

/** The Privacy Policy / Terms link targets embedded in the web-form disclosure. */
export const PRIVACY_POLICY_URL = 'https://tenant.place/privacypolicy';
export const TERMS_URL = 'https://tenant.place/terms';

/**
 * The VERBATIM CTIA web-form consent checkbox label. Rendered on the public
 * intake form with "Privacy Policy" and "Terms" as links (see the JSX in
 * IntakeForm). The plain-string form here is the single source the UI renders +
 * tests assert against — DO NOT edit the wording.
 *
 * do-not-remove — A2P/CTIA consent gate copy (client-side; server also enforces).
 */
export const WEB_FORM_CONSENT_LABEL =
  'I agree to receive recurring texts from Tenant Place LLC about new properties ' +
  'that accept my voucher, tour reminders, and updates. Message frequency varies. ' +
  'Msg & data rates may apply. Reply STOP to opt out, HELP for help. See our ' +
  'Privacy Policy and Terms.';

/** The four HUMAN consent methods (staff-entered on the contact-create form and
 *  the just-in-time modal). The two automatic methods (web_form / inbound_text)
 *  are never chosen by a human, so they are NOT in this list. Values match the
 *  app's ConsentMethod union (mirrored in api/types.ts). */
export const HUMAN_CONSENT_METHODS = [
  'verbal_phone',
  'verbal_in_person',
  'paper_form',
  'imported',
] as const;

export type HumanConsentMethod = (typeof HUMAN_CONSENT_METHODS)[number];

/** Friendly labels for the human consent methods (the dropdown options). */
export const HUMAN_CONSENT_METHOD_LABELS: Readonly<Record<HumanConsentMethod, string>> = {
  verbal_phone: 'Verbal (phone)',
  verbal_in_person: 'Verbal (in person)',
  paper_form: 'Paper form',
  imported: 'Imported',
};

/** Today as YYYY-MM-DD, for the default `when` value on the consent date inputs. */
export function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A YYYY-MM-DD date input value → an ISO 8601 instant (start of that day, UTC)
 *  for the `consent_at` field. Empty/invalid → the current instant. */
export function consentAtFromDate(date: string): string {
  const trimmed = date.trim();
  if (trimmed === '') return new Date().toISOString();
  const parsed = Date.parse(`${trimmed}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}
