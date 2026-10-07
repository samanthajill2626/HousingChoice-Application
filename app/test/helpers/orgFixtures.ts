// Shared organization-list fixtures for the S2-S5 suites (plan
// docs/superpowers/plans/2026-10-06-clean-org-names.md). Fixed ids and
// timestamps so every suite can assert exact bodies. Five entries cover every
// D4 case the services meet: a spelling two housing authorities share (AHA),
// unique spellings (DCA), and two agencies (one with spellings, one without).
import { createLogger, type Logger } from '../../src/lib/logger.js';
import type { OrgEntry, OrgRef } from '../../src/lib/orgNames.js';
import {
  ORG_LIST_SETTING_ID,
  type OrgListItem,
  type OrgRewriteState,
} from '../../src/repos/orgListRepo.js';
import { createLogCapture } from './logCapture.js';

export const ORG_T0 = '2026-10-06T00:00:00.000Z';

export function orgEntry(
  partial: Partial<OrgEntry> & Pick<OrgEntry, 'orgId' | 'kind' | 'name'>,
): OrgEntry {
  return {
    spellings: [],
    createdAt: ORG_T0,
    createdBy: 'test',
    updatedAt: ORG_T0,
    updatedBy: 'test',
    ...partial,
  };
}

export const ATLANTA = orgEntry({
  orgId: 'org-atl',
  kind: 'housing_authority',
  name: 'Atlanta Housing Authority',
  spellings: ['AHA', 'Atlanta Housing', 'Atlanta (AHA)'],
});
export const AUGUSTA = orgEntry({
  orgId: 'org-aug',
  kind: 'housing_authority',
  name: 'Augusta Housing Authority',
  spellings: ['AHA'],
});
export const DCA = orgEntry({
  orgId: 'org-dca',
  kind: 'housing_authority',
  name: 'Georgia Department of Community Affairs',
  spellings: ['DCA', 'Georgia DCA'],
});
export const VASH = orgEntry({
  orgId: 'org-vash',
  kind: 'agency',
  name: 'HUD-Veterans Affairs Supportive Housing (HUD-VASH)',
  spellings: ['HUD-VASH', 'VASH'],
});
export const STEP_UP = orgEntry({ orgId: 'org-stepup', kind: 'agency', name: 'Step Up' });
export const ORG_FIXTURE: readonly OrgEntry[] = [ATLANTA, AUGUSTA, DCA, VASH, STEP_UP];

/** The public reference the services put in refusals and resolutions. */
export function orgRef(e: OrgEntry): OrgRef {
  return { orgId: e.orgId, kind: e.kind, name: e.name };
}

/** A stored org-list item over `entries`, deep-copied so a suite may change it. */
export function orgListItem(
  entries: readonly OrgEntry[] = ORG_FIXTURE,
  extra: { version?: number; lastRewrite?: OrgRewriteState } = {},
): OrgListItem {
  return {
    settingId: ORG_LIST_SETTING_ID,
    version: extra.version ?? 1,
    entries: entries.map((e) => ({ ...e, spellings: [...e.spellings] })),
    ...(extra.lastRewrite !== undefined && { lastRewrite: extra.lastRewrite }),
  };
}

/**
 * A `running` rewrite (plan 3.2) started by `usr_admin`. Its heartbeat is
 * ORG_T0 - pass `heartbeatAt` when a test needs the lock FRESH against its
 * clock (spec D11: a heartbeat 15 minutes old no longer holds the lock).
 * `fields` defaults to `[field]` for a value action and `[]` otherwise - a
 * rename or merge case passes its own (e.g. `['housingAuthority',
 * 'accepted_authorities']`).
 */
export function runningRewrite(
  partial: Partial<OrgRewriteState> & Pick<OrgRewriteState, 'action' | 'fromTexts'>,
): OrgRewriteState {
  return {
    jobId: 'job-1',
    fields: partial.field !== undefined ? [partial.field] : [],
    status: 'running',
    heartbeatAt: ORG_T0,
    startedAt: ORG_T0,
    startedBy: 'usr_admin',
    ...partial,
  };
}

/** A logger whose lines go nowhere (use createLogCapture directly to assert on logs). */
export function quietLogger(): Logger {
  return createLogger({ destination: createLogCapture().stream });
}
