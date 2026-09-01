// Resolver behavior (spec §6): override wins for editable / ignored for
// non-editable; interpolation substitutes declared tokens; a settings-read
// failure falls back to the catalog default (no throw); settingsToOverrides maps
// the legacy editable fields.
import { describe, expect, it } from 'vitest';
import { resolveMessage, settingsToOverrides } from '../../src/messages/resolve.js';
import { resolveWithSettings } from '../../src/messages/resolveWithSettings.js';
import { MESSAGE_CATALOG } from '../../src/messages/catalog.js';
import { DEFAULT_ORG_SETTINGS, type OrgSettings, type SettingsRepo } from '../../src/repos/settingsRepo.js';
import { WELCOME_SMS } from '../../src/lib/smsCompliance.js';

function fakeSettingsRepo(s: OrgSettings): Pick<SettingsRepo, 'getOrgSettings'> {
  return { async getOrgSettings() { return { ...s }; } };
}

describe('resolveMessage', () => {
  // relay.group_closed is the TOKEN-FREE editable example: after the 2026-08-26
  // founder rewrite every tour.* default carries at least one required token (a
  // name, and/or {when}/{time}/{where}), and resolving one bare would (rightly)
  // throw on the missing vars rather than exercise override precedence.
  it('returns the catalog default when no override is supplied', () => {
    expect(resolveMessage('relay.group_closed')).toBe(MESSAGE_CATALOG['relay.group_closed'].default);
  });

  it('an override WINS for an editable entry', () => {
    const out = resolveMessage('relay.group_closed', undefined, {
      'relay.group_closed': 'custom body',
    });
    expect(out).toBe('custom body');
  });

  it('an override is IGNORED for a non-editable (compliance-locked / voice) entry', () => {
    const out = resolveMessage('keyword.stop', undefined, {
      'keyword.stop': 'hacked opt-out copy',
    });
    expect(out).toBe(MESSAGE_CATALOG['keyword.stop'].default);
  });

  it('an empty-string override falls through to the default', () => {
    const out = resolveMessage('relay.group_closed', undefined, { 'relay.group_closed': '' });
    expect(out).toBe(MESSAGE_CATALOG['relay.group_closed'].default);
  });

  it('substitutes a declared token', () => {
    expect(resolveMessage('verify.cell_code', { code: '427193' })).toBe(
      'Your HousingChoice verification code is 427193. It expires in 10 minutes.',
    );
  });

  it('substitutes every occurrence and only declared tokens', () => {
    const out = resolveMessage('welcome.sms', { firstName: 'Keisha' }, {
      'welcome.sms': 'Hi {firstName} {firstName}! Reply STOP. {other} stays.',
    });
    expect(out).toBe('Hi Keisha Keisha! Reply STOP. {other} stays.');
  });

  it('an operator OVERRIDE degrades gracefully (no throw) when a declared token has no value', () => {
    // Regression guard: a personalized welcomeText override can fire on a path
    // with no name (the START/keyword reply passes no firstName). Operator data
    // must NEVER crash a send — an unfilled declared token degrades to empty
    // instead of throwing. (The strict throw is kept for catalog DEFAULTS below.)
    expect(
      resolveMessage('welcome.sms', undefined, { 'welcome.sms': 'Hi {firstName}, welcome!' }),
    ).toBe('Hi , welcome!');
    // ...and still substitutes when a value IS supplied.
    expect(
      resolveMessage('welcome.sms', { firstName: 'Keisha' }, {
        'welcome.sms': 'Hi {firstName}, welcome!',
      }),
    ).toBe('Hi Keisha, welcome!');
  });

  it('THROWS when a catalog DEFAULT declares a token in its copy but no value is supplied (coding-defect guard)', () => {
    // verify.cell_code's DEFAULT contains {code}; a call site that forgets it is
    // a genuine bug — the strict throw stays for code-controlled defaults.
    expect(() => resolveMessage('verify.cell_code', undefined)).toThrow(/missing interpolation var/);
  });

  it('does NOT require a declared var absent from the template (welcome.sms default has no {firstName})', () => {
    expect(resolveMessage('welcome.sms')).toBe(WELCOME_SMS);
    expect(resolveMessage('welcome.sms', { firstName: 'Keisha' })).toBe(WELCOME_SMS);
  });
});

// relay.member_added_role declares ['name','role'] and is non-editable, which
// makes it the strict-mode probe: TWO declared tokens (so one value can carry
// the other's token) on an entry no override can reach. The four behaviours
// pinned here are id-agnostic; the probe moved here from relay.member_added
// when Phase B narrowed that entry to a single {name} (spec 9.4).
describe('interpolate is single-pass', () => {
  it('a substituted value containing a later declared token is NOT re-expanded', () => {
    const out = resolveMessage('relay.member_added_role', {
      name: 'A {role} person',
      role: 'SECRET ROLE',
    });
    // Pre-fix this emits 'A SECRET ROLE person' - the token inside the
    // substituted value must survive as literal text instead.
    expect(out).toContain('A {role} person');
    expect(out).toContain('SECRET ROLE'); // the real token still resolves
  });

  it('replacement-pattern characters in values are inert ($& / $1 / $`)', () => {
    const out = resolveMessage('relay.member_added_role', {
      name: '$& $1 $` $\' joined.',
      role: 'M.',
    });
    expect(out).toContain("$& $1 $` $' joined.");
  });

  it('an UNDECLARED token in the template stays literal', () => {
    const out = resolveMessage('relay.member_added_role', { name: 'J.', role: 'M.' });
    // No entry declares {nope}; craft via the override path instead: undeclared
    // tokens simply are not in `allowed`, so assert on a template that has one.
    // relay.media_only declares only ['name'].
    const out2 = resolveMessage('relay.media_only', { name: 'Ann' }, {
      'relay.media_only': '{name} sent {nope}.',
    });
    expect(out2).toBe('Ann sent {nope}.');
    expect(out).toBeTypeOf('string');
  });

  it('strict default THROWS on a declared-but-missing token; override degrades to empty', () => {
    expect(() => resolveMessage('relay.member_added_role', { name: 'J.' })).toThrow(
      /missing interpolation var "role"/,
    );
    const out = resolveMessage('relay.media_only', {}, { 'relay.media_only': 'Hi {name}!' });
    expect(out).toBe('Hi !');
  });

  it('a declared token ABSENT from the template needs no value', () => {
    // welcome.sms declares {firstName}; its default copy does not use it.
    expect(() => resolveMessage('welcome.sms', {})).not.toThrow();
  });
});

describe('catalog token charset (structural guard for the interpolate regex)', () => {
  // interpolate() scans for /\{([A-Za-z][A-Za-z0-9_]*)\}/g. A future entry that
  // declared a var outside that charset would silently never substitute - and
  // grep cannot see it, because seven vars arrays are spread-built. Iterate the
  // catalog instead so every entry added from here on is covered.
  it('every declared var of every entry matches the interpolate token charset', () => {
    for (const [id, def] of Object.entries(MESSAGE_CATALOG)) {
      for (const token of def.vars) {
        expect(token, `${id} declares ${token}`).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      }
    }
  });
});

describe('settingsToOverrides', () => {
  it('maps welcomeText → welcome.sms and missedCallAutoText → missed_call.autotext', () => {
    const s: OrgSettings = {
      ...DEFAULT_ORG_SETTINGS,
      welcomeText: 'Welcome {firstName}!',
      missedCallAutoText: 'Custom missed. Reply STOP to opt out.',
    };
    expect(settingsToOverrides(s)).toEqual({
      'welcome.sms': 'Welcome {firstName}!',
      'missed_call.autotext': 'Custom missed. Reply STOP to opt out.',
    });
  });

  it('omits welcome.sms when welcomeText is unset (quickReplies never maps)', () => {
    const s: OrgSettings = { ...DEFAULT_ORG_SETTINGS };
    delete s.welcomeText;
    const map = settingsToOverrides(s);
    expect(map['welcome.sms']).toBeUndefined();
    // missedCallAutoText always has a value (its default), so it always maps.
    expect(map['missed_call.autotext']).toBe(DEFAULT_ORG_SETTINGS.missedCallAutoText);
    expect(Object.keys(map)).not.toContain('quickReplies');
  });
});

describe('resolveWithSettings', () => {
  it('honors a welcomeText override via the injected repo', async () => {
    const repo = fakeSettingsRepo({
      ...DEFAULT_ORG_SETTINGS,
      welcomeText: 'Welcome {firstName}! Reply STOP to opt out.',
    });
    const out = await resolveWithSettings('welcome.sms', { firstName: 'Keisha' }, { settingsRepo: repo });
    expect(out).toBe('Welcome Keisha! Reply STOP to opt out.');
  });

  it('falls back to the catalog default when the settings read THROWS (no throw out)', async () => {
    const repo: Pick<SettingsRepo, 'getOrgSettings'> = {
      async getOrgSettings() {
        throw new Error('settings store unavailable');
      },
    };
    const out = await resolveWithSettings('welcome.sms', { firstName: 'Keisha' }, { settingsRepo: repo });
    expect(out).toBe(WELCOME_SMS);
  });

  it('resolves to the default when no override applies', async () => {
    const repo = fakeSettingsRepo({ ...DEFAULT_ORG_SETTINGS });
    const out = await resolveWithSettings('welcome.sms', undefined, { settingsRepo: repo });
    expect(out).toBe(WELCOME_SMS);
  });
});
