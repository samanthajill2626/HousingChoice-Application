// Resolver behavior (spec §6): override wins for editable / ignored for
// non-editable; interpolation substitutes declared tokens; a settings-read
// failure falls back to the catalog default (no throw); settingsToOverrides maps
// the legacy editable fields.
import { describe, expect, it } from 'vitest';
import {
  resolveMessage,
  resolveWithSettings,
  settingsToOverrides,
} from '../../src/messages/resolve.js';
import { MESSAGE_CATALOG } from '../../src/messages/catalog.js';
import { DEFAULT_ORG_SETTINGS, type OrgSettings, type SettingsRepo } from '../../src/repos/settingsRepo.js';
import { WELCOME_SMS } from '../../src/lib/smsCompliance.js';

function fakeSettingsRepo(s: OrgSettings): Pick<SettingsRepo, 'getOrgSettings'> {
  return { async getOrgSettings() { return { ...s }; } };
}

describe('resolveMessage', () => {
  it('returns the catalog default when no override is supplied', () => {
    expect(resolveMessage('tour.day_before')).toBe(MESSAGE_CATALOG['tour.day_before'].default);
  });

  it('an override WINS for an editable entry', () => {
    const out = resolveMessage('tour.day_before', undefined, {
      'tour.day_before': 'custom body',
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
    const out = resolveMessage('tour.day_before', undefined, { 'tour.day_before': '' });
    expect(out).toBe(MESSAGE_CATALOG['tour.day_before'].default);
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
