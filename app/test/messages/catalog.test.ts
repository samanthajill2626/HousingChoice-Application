// Catalog invariants (spec §6): every entry is well-formed; every editable +
// requiresOptOut default keeps opt-out language; token/vars declarations agree.
import { describe, expect, it } from 'vitest';
import { MESSAGE_CATALOG, type MessageDef, type MessageId } from '../../src/messages/catalog.js';
import { resolveMessage } from '../../src/messages/resolve.js';
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

  // relay-intro-editable-but-never-overridden: an entry may only claim to be
  // operator-editable if an operator override can actually REACH the send. For
  // the two relay entries it cannot - nothing stores one, settingsToOverrides
  // does not map one, and the relayFanOut composers call resolveMessage with no
  // overrides argument. Pinned so that flipping the flag back without doing the
  // wiring trips a test instead of silently re-advertising a dead capability.
  it('the relay announcements do NOT claim to be operator-editable (nothing can override them)', () => {
    // Phase B (spec 9.2a) adds four more relay entries under the SAME rationale:
    // there is still no store, no settingsToOverrides mapping and no overrides
    // argument on the composers, so none of them may advertise editability.
    for (const id of [
      'relay.intro',
      'relay.member_added',
      'relay.intro_tour_today',
      'relay.intro_tour',
      'relay.intro_placement',
      'relay.member_added_role',
    ] as const) {
      expect(MESSAGE_CATALOG[id].editable, `editable flag for ${id}`).toBe(false);
    }
    // The guard that gives the flag its meaning: a non-editable entry ignores an
    // override even when one IS handed to the resolver. Re-targeted from
    // {members} to {names} in Phase B - {members} was a whole computed sentence,
    // {names} is the bare list (spec 9.2) - with the intent unchanged.
    expect(resolveMessage('relay.intro', { names: 'M.' }, { 'relay.intro': 'OVERRIDDEN' })).toBe(
      MESSAGE_CATALOG['relay.intro'].default.replace('{names}', 'M.'),
    );
  });

  // Spec 9.2a's metadata table, pinned rather than left to the generic
  // invariants above: {where} is declared LAST in every new entry (spec 9.3's
  // belt-and-braces against the one value that is not brace-stripped), and the
  // two tour variants split {time} / {when} rather than declaring both, which
  // the no-dead-tokens rule above would reject.
  it('the Phase B relay entries declare exactly the spec 9.2a vars, with {where} LAST', () => {
    expect(MESSAGE_CATALOG['relay.intro'].vars).toEqual(['names']);
    expect(MESSAGE_CATALOG['relay.intro_tour_today'].vars).toEqual([
      'tenantFirstName',
      'propertyContactFirstName',
      'time',
      'where',
    ]);
    expect(MESSAGE_CATALOG['relay.intro_tour'].vars).toEqual([
      'tenantFirstName',
      'propertyContactFirstName',
      'when',
      'where',
    ]);
    expect(MESSAGE_CATALOG['relay.intro_placement'].vars).toEqual([
      'tenantFirstName',
      'propertyContactFirstName',
      'where',
    ]);
    expect(MESSAGE_CATALOG['relay.member_added_role'].vars).toEqual(['name', 'role']);
    for (const id of ['relay.intro_tour_today', 'relay.intro_tour', 'relay.intro_placement'] as const) {
      const vars = MESSAGE_CATALOG[id].vars;
      expect(vars[vars.length - 1], `{where} must be declared LAST in ${id}`).toBe('where');
    }
    // class/channel per the same table.
    for (const id of [
      'relay.intro_tour_today',
      'relay.intro_tour',
      'relay.intro_placement',
      'relay.member_added_role',
    ] as const) {
      expect(MESSAGE_CATALOG[id].class, id).toBe('operational');
      expect(MESSAGE_CATALOG[id].channel, id).toBe('sms');
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
    // Phase B (spec 9.4): STOP is omitted on the four new relay entries too.
    // Sam's logged A2P decision for relay intros (changelog 1.2.1 #7) governs -
    // the new member's first contact IS an intro. DECIDED, do not re-open.
    for (const id of [
      'relay.intro_tour_today',
      'relay.intro_tour',
      'relay.intro_placement',
      'relay.member_added_role',
    ] as const) {
      expect(MESSAGE_CATALOG[id].default, `Reply STOP in ${id}`).not.toContain('Reply STOP');
      expect(MESSAGE_CATALOG[id].default, `brand in ${id}`).not.toContain(SMS_BRAND_NAME);
    }
    // FOUNDER DECISION 2026-08-20: the brand identity is now gone from the group
    // intro as well, on Sam's explicit instruction. relay.identity has no send
    // site, so the group intro now carries NEITHER identity NOR opt-out and a
    // stranger's first text no longer says who it is from. Engineering stated
    // that exposure and was overruled; asserted (not merely deleted) so putting
    // the brand back is a deliberate act with a failing test behind it.
    expect(MESSAGE_CATALOG['relay.intro'].default).not.toContain(SMS_BRAND_NAME);
    // The housing-authority sentence went with it - updates come from the
    // landlord, not from Sam. SCOPED TO relay.intro, deliberately: Phase B's
    // relay.intro_placement reinstates such a sentence in a form that HONOURS
    // that rationale (it attributes the updates to the property contact, not to
    // Sam), which is why the 2026-08-20 removal does not reach it (spec 9.1).
    expect(MESSAGE_CATALOG['relay.intro'].default).not.toContain('housing authority');
    expect(MESSAGE_CATALOG['relay.intro_placement'].default).toContain(
      'will share updates as they receive them from the housing authority',
    );
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
