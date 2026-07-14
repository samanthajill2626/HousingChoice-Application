// Catalog invariants (spec §6): every entry is well-formed; every editable +
// requiresOptOut default keeps opt-out language; token/vars declarations agree.
import { describe, expect, it } from 'vitest';
import { MESSAGE_CATALOG, type MessageDef, type MessageId } from '../../src/messages/catalog.js';
import {
  DEFAULT_MISSED_CALL_AUTOTEXT,
  HELP_REPLY,
  RELAY_INTRO_IDENTITY,
  SMS_BRAND_NAME,
  STOP_CONFIRMATION,
  WEB_FORM_CONSENT_COPY,
  WELCOME_SMS,
  templateHasOptOutLanguage,
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
    expect(MESSAGE_CATALOG['missed_call.autotext'].default).toBe(DEFAULT_MISSED_CALL_AUTOTEXT);
    expect(MESSAGE_CATALOG['keyword.stop'].default).toBe(STOP_CONFIRMATION);
    expect(MESSAGE_CATALOG['keyword.help'].default).toBe(HELP_REPLY);
    expect(MESSAGE_CATALOG['consent.web_form'].default).toBe(WEB_FORM_CONSENT_COPY);
    expect(MESSAGE_CATALOG['relay.identity'].default).toBe(RELAY_INTRO_IDENTITY);
    // The relay announcements lead with the brand and TRAIL the opt-out
    // (founder wording 2026-07-14: content first, STOP last).
    expect(MESSAGE_CATALOG['relay.intro'].default).toBe(
      `${SMS_BRAND_NAME}. {members} Reply STOP to opt out.`,
    );
    expect(MESSAGE_CATALOG['relay.member_added'].default).toBe(
      `${SMS_BRAND_NAME}. {joined} {members} Reply STOP to opt out.`,
    );
  });
});
