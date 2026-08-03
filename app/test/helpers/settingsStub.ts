// Shared org-settings stubs for job/route suites (quiet-hours spec 2026-08-03).
//
// The armers/pollers take their settings dependency as the narrow
// Pick<SettingsRepo, 'getOrgSettings'> shape (the resolveWithSettings
// precedent), so a stub only has to supply the READ.
//
// DETERMINISM RULE: a suite that arms rungs but does NOT target quiet hours
// stubs the window OFF (quietOffSettingsRepo) so its dueAt fixtures stay
// exactly what they were before arm-time clamping landed - and so no test
// silently depends on where its fixture instants fall relative to 21:00-08:00.
// Tests that DO target clamping pass fixed instants plus the default (enabled)
// window via stubSettingsRepo().
import {
  DEFAULT_ORG_SETTINGS,
  type OrgSettings,
  type SettingsRepo,
} from '../../src/repos/settingsRepo.js';

/** The read-only settings dep shape the armers/pollers actually require. */
export type SettingsReadRepo = Pick<SettingsRepo, 'getOrgSettings'>;

/** DEFAULT_ORG_SETTINGS with `over` merged on top (quiet hours ON by default). */
export function stubSettingsRepo(over: Partial<OrgSettings> = {}): SettingsReadRepo {
  return {
    async getOrgSettings() {
      return { ...DEFAULT_ORG_SETTINGS, ...over };
    },
  };
}

/** Quiet hours DISABLED: clamping is identity, so raw dueAts are stored as-is. */
export function quietOffSettingsRepo(): SettingsReadRepo {
  return stubSettingsRepo({ quietHoursEnabled: false });
}

/** A settings read that FAILS - callers must fall back to the defaults. */
export function failingSettingsRepo(): SettingsReadRepo {
  return {
    async getOrgSettings() {
      throw new Error('settings unavailable (test stub)');
    },
  };
}
