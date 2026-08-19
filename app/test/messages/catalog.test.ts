// Catalog invariants (spec §6): every entry is well-formed; every editable +
// requiresOptOut default keeps opt-out language; token/vars declarations agree.
import { describe, expect, it } from 'vitest';
import { MESSAGE_CATALOG, type MessageDef, type MessageId } from '../../src/messages/catalog.js';
import {
  DEFAULT_MISSED_CALL_AUTOTEXT,
  FOUNDER_MISSED_CALL_AUTOTEXT,
  HELP_REPLY,
  RELAY_INTRO_IDENTITY,
  SMS_BRAND_NAME,
  STOP_CONFIRMATION,
  WEB_FORM_CONSENT_COPY,
  WELCOME_SMS,
  templateHasOptOutLanguage,
  OPT_IN_CONFIRMATION,
} from '../../src/lib/smsCompliance.js';

const entries = Object.entries(MESSAGE_CATALOG) as Array<[MessageId, MessageDef]>;

/** Extract every `{token}` referenced in a template. */
function tokensIn(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

describe('MESSAGE_CATALOG', () => {
  it('every entry keys itself (def.id === map key) and has a non-empty default', () => {
    for (const [id, def] of entries) {
      expect(def.id, `id mismatch for ${id}`).toBe(id);
      expect(typeof def.default, `default type for ${id}`).toBe('string');
      expect(def.default.length, `empty default for ${id}`).toBeGreaterThan(0);
    }
  });

  it('every {token} in a default is declared in vars', () => {
    for (const [id, def] of entries) {
      for (const token of tokensIn(def.default)) {
        expect(def.vars, `undeclared token {${token}} in ${id}`).toContain(token);
      }
    }
  });

  it('a NON-editable entry uses every var it declares in its default (no dead tokens)', () => {
    // editable entries MAY declare override-only tokens (e.g. welcome.sms {firstName}
    // that the default does not personalize), so the reverse check applies only
    // where the default is the fixed, canonical copy.
    for (const [id, def] of entries) {
      if (def.editable) continue;
      const inDefault = new Set(tokensIn(def.default));
      for (const v of def.vars) {
        expect(inDefault.has(v), `declared var {${v}} unused in non-editable ${id}`).toBe(true);
      }
    }
  });

  it('every editable + requiresOptOut default keeps opt-out language (the A2P floor)', () => {
    for (const [id, def] of entries) {
      if (def.editable && def.requiresOptOut === true) {
        expect(templateHasOptOutLanguage(def.default), `no opt-out language in ${id}`).toBe(true);
      }
    }
  });

  it('class and channel are from the allowed sets', () => {
    for (const [id, def] of entries) {
      expect(
        ['operational', 'compliance-locked', 'voice', 'transactional'],
        `class for ${id}`,
      ).toContain(def.class);
      expect(['sms', 'voice'], `channel for ${id}`).toContain(def.channel);
    }
  });

  it('compliance copy references smsCompliance.ts constants verbatim (never re-literaled)', () => {
    // These defaults MUST equal the imported A2P single-source constants.
    expect(MESSAGE_CATALOG['welcome.sms'].default).toBe(WELCOME_SMS);
    // FOUNDER DECISION 2026-08-18: the missed-call auto-text now points at the
    // founder wording, NOT the filed A2P constant. DEFAULT_MISSED_CALL_AUTOTEXT
    // is deliberately left in place as the registered copy we would restore to.
    expect(MESSAGE_CATALOG['missed_call.autotext'].default).toBe(FOUNDER_MISSED_CALL_AUTOTEXT);
    expect(FOUNDER_MISSED_CALL_AUTOTEXT).not.toBe(DEFAULT_MISSED_CALL_AUTOTEXT);
    expect(MESSAGE_CATALOG['keyword.stop'].default).toBe(STOP_CONFIRMATION);
    expect(MESSAGE_CATALOG['keyword.help'].default).toBe(HELP_REPLY);
    expect(MESSAGE_CATALOG['keyword.optin'].default).toBe(OPT_IN_CONFIRMATION);
    expect(MESSAGE_CATALOG['consent.web_form'].default).toBe(WEB_FORM_CONSENT_COPY);
    expect(MESSAGE_CATALOG['relay.identity'].default).toBe(RELAY_INTRO_IDENTITY);
    // FOUNDER DECISION 2026-08-18: the relay announcements NO LONGER carry
    // "Reply STOP to opt out.". Engineering advised against removing it (both
    // are first-contact messages, so it is the A2P floor) and was overruled;
    // full attribution is in catalog.ts above these entries. Asserted rather
    // than merely deleted, so restoring the line is a deliberate act with a
    // failing test behind it, not an accident.
    expect(MESSAGE_CATALOG['relay.intro'].default).not.toContain('Reply STOP');
    expect(MESSAGE_CATALOG['relay.member_added'].default).not.toContain('Reply STOP');
    // The brand identity half IS kept - a stranger's first text from an unknown
    // number still says who it is from.
    expect(MESSAGE_CATALOG['relay.intro'].default).toContain(SMS_BRAND_NAME);
    // relay.identity still pins the filed brand + opt-out string, untouched.
    expect(MESSAGE_CATALOG['relay.identity'].default).toBe(RELAY_INTRO_IDENTITY);
  });

  // The opt-out floor still applies everywhere it was NOT explicitly lifted.
  // welcome.sms keeps requiresOptOut; missed_call.autotext had it removed by the
  // same founder decision. If a future edit re-adds requiresOptOut to the
  // missed-call entry without restoring a STOP line, the invariant test above
  // will fail - which is the intended tripwire.
  it('the opt-out requirement is lifted ONLY where the founder decision applies', () => {
    expect(MESSAGE_CATALOG['welcome.sms'].requiresOptOut).toBe(true);
    expect(MESSAGE_CATALOG['missed_call.autotext'].requiresOptOut).toBeUndefined();
  });
});
