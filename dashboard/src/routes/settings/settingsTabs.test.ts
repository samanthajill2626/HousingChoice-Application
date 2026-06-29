// settingsTabs unit tests — the SINGLE source of truth for the Settings tab
// model. Asserts the role-gating helpers: visibleTabs(isAdmin) and
// defaultTabPath(isAdmin). Team + System status are admin-only; Templates +
// Notifications are visible to everyone.
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_TABS,
  VA_DEFAULT_TAB_PATH,
  defaultTabPath,
  visibleTabs,
} from './settingsTabs.js';

describe('settingsTabs', () => {
  it('the model carries all four sections in order, with the admin-only flags', () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual([
      'team',
      'templates',
      'notifications',
      'system',
    ]);
    expect(SETTINGS_TABS.filter((t) => t.adminOnly).map((t) => t.id)).toEqual(['team', 'system']);
  });

  it('visibleTabs(true) returns all four tabs (admin sees Team + System)', () => {
    expect(visibleTabs(true).map((t) => t.id)).toEqual([
      'team',
      'templates',
      'notifications',
      'system',
    ]);
  });

  it('visibleTabs(false) returns only Templates + Notifications (no Team, no System)', () => {
    expect(visibleTabs(false).map((t) => t.id)).toEqual(['templates', 'notifications']);
  });

  it('defaultTabPath lands an admin on Team and a VA on Templates', () => {
    expect(defaultTabPath(true)).toBe('/settings/team');
    expect(defaultTabPath(false)).toBe('/settings/templates');
  });

  it('the VA default tab matches the templates path (the admin-route redirect target)', () => {
    expect(VA_DEFAULT_TAB_PATH).toBe('/settings/templates');
    expect(defaultTabPath(false)).toBe(VA_DEFAULT_TAB_PATH);
  });
});
