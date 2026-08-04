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

const HOUR_MS = 60 * 60 * 1000;
const hhmmUtc = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/**
 * An ISO instant `hours` from now, normalized the way the store holds `dueAt`.
 * Pair it with the two window helpers below to place a rung inside or outside a
 * window OCCURRENCE without depending on the time of day the suite runs.
 */
export function isoHoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * HOUR_MS).toISOString();
}

/**
 * A quiet-hours window that ALWAYS contains the wall clock: start = one hour
 * ago, end = one hour ahead, evaluated in UTC.
 *
 * A fixed "21:00-08:00" fixture would make a wall-clock assertion pass or fail
 * depending on the time of day the suite runs, so quiet-case suites build the
 * window from the current time instead and use `quietHoursEnabled: false` for
 * the non-quiet case; never a fixed HH:MM.
 *
 * Windows RECUR daily, so relative to THIS window: `isoHoursFromNow(24)` (the
 * same wall time tomorrow) is INSIDE tomorrow's occurrence, while
 * `isoHoursFromNow(6)` - or `isoHoursFromNow(3 * 24 + 6)` - is outside every
 * occurrence. The views chip a rung whose own dueAt is inside an occurrence, or
 * that is already due while the window is running.
 */
export function quietWindowAroundNow(): Pick<
  OrgSettings,
  'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd' | 'timezone'
> {
  const now = Date.now();
  return {
    quietHoursEnabled: true,
    quietHoursStart: hhmmUtc(now - HOUR_MS),
    quietHoursEnd: hhmmUtc(now + HOUR_MS),
    timezone: 'UTC',
  };
}

/** Settings stub whose window always contains the wall clock (see above). */
export function quietNowSettingsRepo(): SettingsReadRepo {
  return stubSettingsRepo(quietWindowAroundNow());
}

/**
 * A quiet-hours window that NEVER contains the wall clock: it opens three hours
 * from now and closes five hours from now, evaluated in UTC.
 *
 * Because windows recur daily, `isoHoursFromNow(4)` (and +24h, +48h ... of it)
 * sits INSIDE an occurrence while the clock sits outside one - the "a rung due
 * at 23:00 tonight, read during business hours" case the per-rung quiet chip
 * exists for. `isoHoursFromNow(1)` is the control: future, but outside.
 */
export function quietWindowAwayFromNow(): Pick<
  OrgSettings,
  'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd' | 'timezone'
> {
  const now = Date.now();
  return {
    quietHoursEnabled: true,
    quietHoursStart: hhmmUtc(now + 3 * HOUR_MS),
    quietHoursEnd: hhmmUtc(now + 5 * HOUR_MS),
    timezone: 'UTC',
  };
}

/** Settings stub whose window never contains the wall clock (see above). */
export function quietLaterSettingsRepo(): SettingsReadRepo {
  return stubSettingsRepo(quietWindowAwayFromNow());
}
