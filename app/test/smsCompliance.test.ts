// smsCompliance — unit tests. These are DRIFT GUARDS: every filed copy string is
// pinned VERBATIM against the design spec
// (docs/superpowers/specs/2026-06-30-a2p-sms-compliance-design.md §3/§5/§6).
// A failure here means SMS-facing copy no longer matches the approved campaign.
import { describe, it, expect } from 'vitest';
import {
  SMS_BRAND_NAME,
  PRIVACY_POLICY_URL,
  TERMS_URL,
  CONSENT_VERSION,
  AUTOMATIC_CONSENT_METHODS,
  HUMAN_CONSENT_METHODS,
  hasSmsConsent,
  consentMethodFromCaptureSource,
  WELCOME_SMS,
  STOP_CONFIRMATION,
  HELP_REPLY,
  WEB_FORM_CONSENT_COPY,
  DEFAULT_MISSED_CALL_AUTOTEXT,
  RELAY_INTRO_IDENTITY,
  OPT_OUT_KEYWORDS,
  OPT_IN_KEYWORDS,
  templateHasOptOutLanguage,
} from '../src/lib/smsCompliance.js';

describe('brand + links', () => {
  it('pins the registered A2P brand name', () => {
    expect(SMS_BRAND_NAME).toBe('Tenant Place LLC');
  });
  it('pins the policy links', () => {
    expect(PRIVACY_POLICY_URL).toBe('https://tenant.place/privacypolicy');
    expect(TERMS_URL).toBe('https://tenant.place/terms');
  });
});

describe('hasSmsConsent — the A2P/CTIA consent gate', () => {
  it('is true iff consent_method is a non-empty string', () => {
    expect(hasSmsConsent({ consent_method: 'web_form' })).toBe(true);
    expect(hasSmsConsent({ consent_method: 'verbal_phone' })).toBe(true);
    expect(hasSmsConsent({})).toBe(false);
    expect(hasSmsConsent({ consent_method: '' })).toBe(false);
    expect(hasSmsConsent({ consent_method: undefined })).toBe(false);
    // Non-string junk never counts as consent.
    expect(hasSmsConsent({ consent_method: 123 as unknown })).toBe(false);
    expect(hasSmsConsent({ consent_method: true as unknown })).toBe(false);
  });
});

describe('consent method sets', () => {
  it('splits automatic vs human methods', () => {
    expect([...AUTOMATIC_CONSENT_METHODS].sort()).toEqual(['inbound_text', 'web_form']);
    expect([...HUMAN_CONSENT_METHODS].sort()).toEqual([
      'imported',
      'paper_form',
      'verbal_in_person',
      'verbal_phone',
    ]);
  });
  it('pins the disclosure version', () => {
    expect(CONSENT_VERSION).toBe('ctia-2026-06');
  });
});

describe('consentMethodFromCaptureSource — backfill mapping', () => {
  it('maps inbound_sms → inbound_text', () => {
    expect(consentMethodFromCaptureSource('inbound_sms')).toBe('inbound_text');
  });
  it('maps housing_fair and flyer → web_form', () => {
    expect(consentMethodFromCaptureSource('housing_fair')).toBe('web_form');
    expect(consentMethodFromCaptureSource('flyer')).toBe('web_form');
  });
  it('returns undefined for unknown / absent sources', () => {
    expect(consentMethodFromCaptureSource('something_else')).toBeUndefined();
    expect(consentMethodFromCaptureSource(undefined)).toBeUndefined();
  });
});

describe('filed copy — verbatim (spec §3/§5/§6)', () => {
  it('WELCOME_SMS', () => {
    expect(WELCOME_SMS).toBe(
      "Welcome to Tenant Place LLC! You're signed up for new properties that accept your voucher, plus tour reminders and updates. Msg frequency varies. Msg & data rates may apply. Reply STOP to unsubscribe, HELP for help.",
    );
  });
  it('STOP_CONFIRMATION', () => {
    expect(STOP_CONFIRMATION).toBe(
      'You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.',
    );
  });
  it('HELP_REPLY', () => {
    expect(HELP_REPLY).toBe(
      'Tenant Place LLC: housing listing alerts for voucher holders. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out. More info: tenant.place.',
    );
  });
  it('HELP_REPLY contains NO phone number / digit (campaign declares phone-numbers = No)', () => {
    expect(HELP_REPLY).not.toMatch(/\d/);
  });
  it('WEB_FORM_CONSENT_COPY', () => {
    expect(WEB_FORM_CONSENT_COPY).toBe(
      'I agree to receive recurring texts from Tenant Place LLC about new properties that accept my voucher, tour reminders, and updates. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. See our Privacy Policy and Terms.',
    );
  });
  it('DEFAULT_MISSED_CALL_AUTOTEXT prepends brand and ends with opt-out', () => {
    expect(DEFAULT_MISSED_CALL_AUTOTEXT).toBe(
      "Tenant Place LLC: Sorry we missed your call! To get started, please text us your full name, voucher size, and housing authority and we'll be right with you. Reply STOP to opt out.",
    );
    expect(DEFAULT_MISSED_CALL_AUTOTEXT.startsWith('Tenant Place LLC: ')).toBe(true);
    expect(DEFAULT_MISSED_CALL_AUTOTEXT.endsWith(' Reply STOP to opt out.')).toBe(true);
  });
  it('RELAY_INTRO_IDENTITY carries brand + opt-out', () => {
    expect(RELAY_INTRO_IDENTITY).toBe('Tenant Place LLC. Reply STOP to opt out.');
  });
});

describe('keyword sets (spec §6 — match the filed campaign)', () => {
  it('opt-out set includes the required additions (OPTOUT, REVOKE) + standard set', () => {
    for (const kw of ['OPTOUT', 'CANCEL', 'END', 'QUIT', 'UNSUBSCRIBE', 'REVOKE', 'STOP', 'STOPALL']) {
      expect(OPT_OUT_KEYWORDS.has(kw)).toBe(true);
    }
  });
  it('opt-in set includes the required additions (JOIN, HOME) + keeps UNSTOP', () => {
    for (const kw of ['START', 'JOIN', 'HOME', 'YES', 'UNSTOP']) {
      expect(OPT_IN_KEYWORDS.has(kw)).toBe(true);
    }
  });
});

describe('templateHasOptOutLanguage — A2P/CTIA compliance floor', () => {
  it('accepts a compliant first-contact template', () => {
    expect(templateHasOptOutLanguage(WELCOME_SMS)).toBe(true);
    expect(templateHasOptOutLanguage('Hi! Reply STOP to opt out.')).toBe(true);
    expect(templateHasOptOutLanguage('reply stop to unsubscribe')).toBe(true);
  });
  it('rejects a template with the STOP line removed', () => {
    expect(
      templateHasOptOutLanguage(
        "Welcome to Tenant Place LLC! You're signed up for new properties.",
      ),
    ).toBe(false);
  });
  it('does not count STOP embedded in another word', () => {
    expect(templateHasOptOutLanguage('nonstop updates all day')).toBe(false);
  });
});
