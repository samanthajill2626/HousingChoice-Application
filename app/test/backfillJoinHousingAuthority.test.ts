// The /join housing authority backfill (spec
// docs/superpowers/specs/2026-10-12-join-housing-authority-design.md, D10
// and D11). The PURE rules first: who is a candidate, and which audit history
// leaves one out - each writer's payload exactly as it appends it today.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger, type Logger } from '../src/lib/logger.js';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import { getTableSpec } from '../src/lib/tables.js';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { createOrgListRepo, type OrgListItem, type OrgListRepo, type OrgRewriteState } from '../src/repos/orgListRepo.js';
import {
  BACKFILL_ARGS,
  BACKFILL_AUDIT_TYPE,
  BACKFILL_AUTHORITY,
  BACKFILL_EXCLUDED_AUDIT_TYPE,
  BackfillRefusedError,
  backfillExitCode,
  buildBackfillDeps,
  checkBackfillList,
  formatBackfillReport,
  isCandidate,
  leftOutReasonFor,
  leftOutReasonFromAudit,
  main,
  parseSkipList,
  readWholeHistory,
  runJoinAuthorityBackfill,
  scanCandidates,
  touchesHousingAuthority,
  USAGE,
  type BackfillDeps,
  type BackfillLead,
  type BackfillOptions,
  type BackfillReport,
} from '../scripts/backfill-join-housing-authority.js';
import { parseStageArgs, type StageClient } from '../scripts/lib/stageClient.js';
import { createLogCapture } from './helpers/logCapture.js';

/** A /join lead from before the change, as the sign-up created it: no authority, no marker. */
const LEAD: ContactItem = {
  contactId: 'c-lead',
  type: 'tenant',
  status: 'needs_review',
  phone: '+15550001001',
  firstName: 'Avery',
  lastName: 'Fairlead',
  capture_source: 'housing_fair',
  captured_at: '2026-06-20T14:00:00.000Z',
  created_at: '2026-06-20T14:00:00.000Z',
  housing_fair_welcomed: true,
  consent_method: 'web_form',
};

const event = (event_type: string, payload?: Record<string, unknown>): AuditEvent => ({
  entityKey: 'contacts#c-lead',
  ts: '2026-07-02T00:00:00.000Z#aaaa0000',
  event_type,
  ...(payload !== undefined && { payload }),
});

type EventCase = [what: string, eventType: string, payload: Record<string, unknown>];

/**
 * Every event that records housingAuthority SET or REMOVED, in the payload
 * shape its writer appends (verified on main @19607658). AI extraction and an
 * accepted AI suggestion only ever SET it; the other writers set and remove.
 */
const AUTHORITY_EVENTS: EventCase[] = [
  ['a staff edit sets it (PATCH fields)', 'contact_updated', { fields: ['housingAuthority'], actor: 'user-0001' }],
  ['a staff edit clears it (PATCH fields)', 'contact_updated', { fields: ['status', 'housingAuthority'], actor: 'user-0001' }],
  [
    'the caseworker conversion removes it (every patch key)',
    'contact_updated',
    {
      fields: [
        'type',
        'role',
        'status',
        'type_source',
        'organization',
        'agency',
        'housingAuthority',
        'housingAuthority_source',
        'caseworker_conversion',
      ],
      actor: 'user-0001',
      conversion: 'caseworker',
    },
  ],
  [
    'AI extraction sets it (fields[].field)',
    'ai_extraction_applied',
    {
      fields: [
        { field: 'voucherSize', to: 2 },
        { field: 'housingAuthority', to: 'Atlanta Housing Authority' },
      ],
      conversationId: 'conv-1',
    },
  ],
  [
    'an accepted AI suggestion sets it (target)',
    'ai_suggestion_accepted',
    { actor: 'user-0001', target: 'housingAuthority', from: 'DeKalb County Housing Authority', to: 'Atlanta Housing Authority' },
  ],
  [
    'an org rewrite sets it (Use)',
    'org_name_rewrite',
    { field: 'housingAuthority', from: 'Atlanta (AHA)', to: 'Atlanta Housing Authority', action: 'use', actor: 'user-0001' },
  ],
  [
    'an org rewrite removes it (Clear)',
    'org_name_rewrite',
    { field: 'housingAuthority', from: 'junk', to: '', action: 'clear', actor: 'user-0001' },
  ],
  ['the cleanup rewrites it', 'org_name_cleanup', { field: 'housingAuthority', from: 'Atlanta (AHA)', to: 'Atlanta Housing Authority' }],
  ['the cleanup removes it (moved to Agency)', 'org_name_cleanup', { field: 'housingAuthority', from: 'Hope Atlanta', to: '' }],
  ['this backfill set it', 'housing_authority_backfill', { field: 'housingAuthority', from: '', to: 'Atlanta Housing Authority' }],
];

/** Events that never leave a lead out. */
const UNRELATED_EVENTS: EventCase[] = [
  ['a staff edit of other fields', 'contact_updated', { fields: ['status', 'notes'], actor: 'user-0001' }],
  ['a caseworker review dismissed', 'contact_updated', { fields: ['caseworker_review'], actor: 'user-0001' }],
  ['AI extraction of other fields', 'ai_extraction_applied', { fields: [{ field: 'voucherSize', to: 2 }], conversationId: 'conv-1' }],
  ['an accepted suggestion for another target', 'ai_suggestion_accepted', { actor: 'user-0001', target: 'voucherSize', from: 2, to: 3 }],
  [
    'a dismissed housing authority suggestion (writes nothing)',
    'ai_suggestion_dismissed',
    { actor: 'user-0001', target: 'housingAuthority' },
  ],
  [
    'an org rewrite of the agency',
    'org_name_rewrite',
    { field: 'agency', from: 'Hope Atlanta', to: 'HOPE Atlanta', action: 'use', actor: 'user-0001' },
  ],
  ['the cleanup of the agency', 'org_name_cleanup', { field: 'agency', from: '', to: 'HOPE Atlanta' }],
  [
    'a sign-up BEFORE the change (no signupVersion)',
    'housing_fair_signup',
    { marker: 'mk', isNew: true, welcomeSent: true, viaFlyer: false },
  ],
  ['a phone added', 'contact_phone_added', { actor: 'user-0001', phone: '+15550001002' }],
];

/** A sign-up AFTER the change from a phone that was already a lead (spec D6, D7). */
const RESIGNUP_PAYLOAD = {
  marker: 'mk',
  isNew: false,
  welcomeSent: false,
  viaFlyer: false,
  signupVersion: 2,
  housingAuthority: 'DeKalb County Housing Authority',
};

describe('the constants (spec D10)', () => {
  it('writes Atlanta Housing Authority under its own audit event type, and records an --apply exclusion under another', () => {
    expect(BACKFILL_AUTHORITY).toBe('Atlanta Housing Authority');
    expect(BACKFILL_AUDIT_TYPE).toBe('housing_authority_backfill');
    expect(BACKFILL_EXCLUDED_AUDIT_TYPE).toBe('housing_authority_backfill_excluded');
  });
});

describe('isCandidate (spec D10: the stored item alone)', () => {
  it('a pre-change /join lead is a candidate, whatever its status', () => {
    expect(isCandidate(LEAD)).toBe(true);
    for (const status of ['onboarding', 'searching', 'on_hold', 'inactive']) {
      expect(isCandidate({ ...LEAD, status })).toBe(true);
    }
    const { status: _status, ...noStatus } = LEAD;
    expect(isCandidate(noStatus as ContactItem)).toBe(true);
  });

  it.each([
    ['a flyer sign-up for a shareable unit', { capture_source: 'flyer' }],
    ['an inbound-text stub', { capture_source: 'inbound_sms' }],
    ['no capture_source', { capture_source: undefined }],
    ['a landlord', { type: 'landlord' }],
    ['a partner (a caseworker)', { type: 'partner' }],
    ['an unknown', { type: 'unknown' }],
    ['a deleted lead', { deleted_at: '2026-09-01T00:00:00.000Z' }],
    ['a lead holding another authority', { housingAuthority: 'DeKalb County Housing Authority' }],
    ['a lead already holding Atlanta Housing Authority', { housingAuthority: 'Atlanta Housing Authority' }],
    ['a contact created after the change (the marker)', { housing_fair_signup_v2: true }],
    ['a marker of any value', { housing_fair_signup_v2: false }],
  ] as Array<[string, Partial<ContactItem>]>)('is not a candidate: %s', (_what, change) => {
    expect(isCandidate({ ...LEAD, ...change } as ContactItem)).toBe(false);
  });
});

describe('leftOutReasonFromAudit (spec D10: the WHOLE history, any order)', () => {
  it('no history, or only unrelated events, leaves nothing out', () => {
    expect(leftOutReasonFromAudit([])).toBeNull();
    expect(leftOutReasonFromAudit(UNRELATED_EVENTS.map(([, type, payload]) => event(type, payload)))).toBeNull();
  });

  it.each(AUTHORITY_EVENTS)('housingAuthority set or removed: %s', (_what, type, payload) => {
    expect(touchesHousingAuthority(event(type, payload))).toBe(true);
    expect(leftOutReasonFromAudit([event('contact_updated', { fields: ['status'] }), event(type, payload)])).toBe(
      'authority_history',
    );
  });

  it.each(UNRELATED_EVENTS)('not an authority write: %s', (_what, type, payload) => {
    expect(touchesHousingAuthority(event(type, payload))).toBe(false);
  });

  it('a sign-up after the change (signupVersion 2) leaves the lead out - and wins over an authority history', () => {
    expect(leftOutReasonFromAudit([event('housing_fair_signup', RESIGNUP_PAYLOAD)])).toBe('signed_up_again');
    expect(
      leftOutReasonFromAudit([event('housing_fair_signup', { ...RESIGNUP_PAYLOAD, housingAuthority: null })]),
    ).toBe('signed_up_again');
    expect(
      leftOutReasonFromAudit([
        event('contact_updated', { fields: ['housingAuthority'] }),
        event('housing_fair_signup', RESIGNUP_PAYLOAD),
      ]),
    ).toBe('signed_up_again');
    // Only the NUMBER 2 marks a post-change sign-up.
    expect(leftOutReasonFromAudit([event('housing_fair_signup', { ...RESIGNUP_PAYLOAD, signupVersion: '2' })])).toBeNull();
  });

  it('an exclusion recorded by an earlier --apply leaves the lead out - and wins over a post-change sign-up and an authority history; it is not itself authority history', () => {
    const excluded = event(BACKFILL_EXCLUDED_AUDIT_TYPE, { field: 'housingAuthority' });
    expect(touchesHousingAuthority(excluded)).toBe(false);
    expect(leftOutReasonFromAudit([excluded])).toBe('excluded_earlier');
    expect(
      leftOutReasonFromAudit([
        event('contact_updated', { fields: ['housingAuthority'] }),
        event('housing_fair_signup', RESIGNUP_PAYLOAD),
        excluded,
      ]),
    ).toBe('excluded_earlier');
    // Whatever it carries: the event type alone records the operator's decision.
    expect(leftOutReasonFromAudit([event(BACKFILL_EXCLUDED_AUDIT_TYPE)])).toBe('excluded_earlier');
  });

  it('a payload in no writer shape is never a match', () => {
    expect(
      leftOutReasonFromAudit([
        event('contact_updated'),
        event('contact_updated', { fields: 'housingAuthority' }),
        event('ai_extraction_applied', { fields: ['housingAuthority'] }),
        event('org_name_rewrite', { field: ['housingAuthority'] }),
      ]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The report the operator reads (pure). Names go to the PRINTED report only.
// ---------------------------------------------------------------------------

const lead = (contactId: string, firstName: string, lastName: string, signedUpAt: string, status: string): BackfillLead => ({
  contactId,
  firstName,
  lastName,
  signedUpAt,
  status,
});

const DRY_REPORT: BackfillReport = {
  targets: [
    { ...lead('c-1', 'Avery', 'Fairlead', '2026-06-20T14:00:00.000Z', 'needs_review'), outcome: 'would_write' },
    { ...lead('c-2', 'Blake', '', '2026-08-15T23:30:00.000Z', 'on_hold'), outcome: 'would_write' },
  ],
  leftOut: [
    { ...lead('c-3', 'Drew', 'Dekalbson', '2026-06-01T09:00:00.000Z', 'needs_review'), reason: 'skipped' },
    { ...lead('c-7', 'Harper', 'Earlier', '2026-06-05T09:00:00.000Z', 'needs_review'), reason: 'excluded_earlier' },
    { ...lead('c-4', 'Emery', 'Again', '2026-06-10T09:00:00.000Z', 'onboarding'), reason: 'signed_up_again' },
    { ...lead('c-5', '', '', '', ''), reason: 'authority_history' },
  ],
  unknownSkips: [],
  missingSkips: [],
  written: 0,
  skipped: 0,
  failed: 0,
  warnings: [],
};

describe('formatBackfillReport (spec D10: name, sign-up date, status, contactId - oldest first)', () => {
  it('dry run: each target on its own line, then the count; then the left-out leads with the reason', () => {
    expect(formatBackfillReport(DRY_REPORT, false)).toEqual([
      'DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):',
      '  Avery Fairlead  signed up 2026-06-20  status needs_review  contactId c-1',
      '  Blake  signed up 2026-08-15  status on_hold  contactId c-2',
      'Would update: 2 lead(s). Failed: 0.',
      'Left out (4 lead(s), oldest sign-up first):',
      '  Drew Dekalbson  signed up 2026-06-01  status needs_review  contactId c-3  - named in --skip',
      '  Harper Earlier  signed up 2026-06-05  status needs_review  contactId c-7  - excluded on an earlier run',
      '  Emery Again  signed up 2026-06-10  status onboarding  contactId c-4  - signed up again after the change',
      '  (no name)  signed up unknown  status (none)  contactId c-5  - its housing authority was set or removed before - left empty on purpose',
    ]);
  });

  it('apply: each outcome, the counts, the unknown --skip ids and every warning', () => {
    const applied: BackfillReport = {
      ...DRY_REPORT,
      targets: [
        { ...lead('c-1', 'Avery', 'Fairlead', '2026-06-20T14:00:00.000Z', 'needs_review'), outcome: 'written' },
        { ...lead('c-2', 'Blake', '', '2026-08-15T23:30:00.000Z', 'on_hold'), outcome: 'skipped' },
        { ...lead('c-6', 'Gray', 'Failson', '2026-09-01T12:00:00.000Z', 'needs_review'), outcome: 'write_failed' },
      ],
      leftOut: [],
      unknownSkips: ['contact-typo', 'contact-xyz'],
      written: 1,
      skipped: 1,
      failed: 1,
      warnings: ['first warning', 'second warning'],
    };
    expect(formatBackfillReport(applied, true)).toEqual([
      'Leads given "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):',
      '  Avery Fairlead  signed up 2026-06-20  status needs_review  contactId c-1',
      '  Blake  signed up 2026-08-15  status on_hold  contactId c-2  - SKIPPED: it changed after the run read it (nothing written)',
      '  Gray Failson  signed up 2026-09-01  status needs_review  contactId c-6  - FAILED: the write may or may not have landed (an ERROR line names this contactId) - re-run the dry run to see',
      'Written: 1. Skipped (changed after the read): 1. Failed: 1.',
      'Left out: none.',
      '--skip ids that are not candidates (ignored): contact-typo, contact-xyz',
      'WARNING: first warning',
      'WARNING: second warning',
    ]);
  });

  it('a dry run counts only the leads it would write; a failed lead is listed and counted apart', () => {
    const dryFailed: BackfillReport = {
      ...DRY_REPORT,
      targets: [
        { ...lead('c-1', 'Avery', 'Fairlead', '2026-06-20T14:00:00.000Z', 'needs_review'), outcome: 'would_write' },
        { ...lead('c-6', 'Gray', 'Failson', '2026-09-01T12:00:00.000Z', 'needs_review'), outcome: 'read_failed' },
      ],
      failed: 1,
    };
    const lines = formatBackfillReport(dryFailed, false);
    expect(lines).toContain(
      '  Gray Failson  signed up 2026-09-01  status needs_review  contactId c-6  - FAILED: nothing written (an ERROR line names this contactId); re-run',
    );
    expect(lines).toContain('Would update: 1 lead(s). Failed: 1.');
  });

  it('apply: a lead named in --skip whose exclusion could not be recorded is a FAILED left-out line', () => {
    const lines = formatBackfillReport(
      {
        ...DRY_REPORT,
        targets: [],
        leftOut: [
          {
            ...lead('c-3', 'Drew', 'Dekalbson', '2026-06-01T09:00:00.000Z', 'needs_review'),
            reason: 'skipped',
            exclusionFailed: true,
          },
        ],
        failed: 1,
      },
      true,
    );
    expect(lines).toEqual([
      'Leads given "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):',
      '  (none)',
      'Written: 0. Skipped (changed after the read): 0. Failed: 1.',
      'Left out (1 lead(s), oldest sign-up first):',
      '  Drew Dekalbson  signed up 2026-06-01  status needs_review  contactId c-3  - named in --skip - FAILED: its exclusion could not be recorded (an ERROR line names this contactId) - keep it in --skip and re-run the apply',
    ]);
  });

  it('a dry run lists each --skip id that names no contact on its own line - apart from the ids that name a non-candidate', () => {
    const lines = formatBackfillReport(
      { ...DRY_REPORT, unknownSkips: ['c-flyer'], missingSkips: ['c-nobody', 'c-typo'] },
      false,
    );
    expect(lines.slice(-3)).toEqual([
      '--skip id that names no contact (a typo?) - an --apply refuses to run with it: c-nobody',
      '--skip id that names no contact (a typo?) - an --apply refuses to run with it: c-typo',
      '--skip ids that are not candidates (ignored): c-flyer',
    ]);
  });

  it('no target and nothing left out', () => {
    expect(formatBackfillReport({ ...DRY_REPORT, targets: [], leftOut: [] }, false)).toEqual([
      'DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):',
      '  (none)',
      'Would update: 0 lead(s). Failed: 0.',
      'Left out: none.',
    ]);
  });

  it('a name from the public form never starts a report line or reaches the terminal raw: control characters (0-31, 127-159) show escaped, every other character as it is', () => {
    // Every character built from its code (code review R1-ADV-4): a newline
    // that would forge a report line, an ESC line-erase, the C1 range's ends,
    // and the neighbors that stay as they are (a quote, an accented letter,
    // a no-break space).
    const ch = (code: number): string => String.fromCharCode(code);
    const BS = ch(92);
    const forged = `Mallory${ch(10)}  Forged Line  signed up 2026-06-02  status needs_review  contactId c-forged`;
    const report: BackfillReport = {
      ...DRY_REPORT,
      targets: [
        { ...lead('c-nl', forged, 'X', '2026-06-01T09:00:00.000Z', 'needs_review'), outcome: 'would_write' },
        { ...lead('c-esc', `${ch(27)}[2K${ch(13)}Eve`, 'Y', '2026-06-03T09:00:00.000Z', 'needs_review'), outcome: 'would_write' },
      ],
      leftOut: [
        {
          ...lead('c-plain', `Ren${ch(233)}e "Bo"`, `O'Brien${ch(9)}${ch(127)}${ch(155)}${ch(159)}${ch(160)}~`, '2026-06-04T09:00:00.000Z', 'on_hold'),
          reason: 'skipped',
        },
      ],
    };
    const lines = formatBackfillReport(report, false);
    expect(lines).toEqual([
      'DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):',
      `  Mallory${BS}x0a  Forged Line  signed up 2026-06-02  status needs_review  contactId c-forged X  signed up 2026-06-01  status needs_review  contactId c-nl`,
      `  ${BS}x1b[2K${BS}x0dEve Y  signed up 2026-06-03  status needs_review  contactId c-esc`,
      'Would update: 2 lead(s). Failed: 0.',
      'Left out (1 lead(s), oldest sign-up first):',
      `  Ren${ch(233)}e "Bo" O'Brien${BS}x09${BS}x7f${BS}x9b${BS}x9f${ch(160)}~  signed up 2026-06-04  status on_hold  contactId c-plain  - named in --skip`,
    ]);
    const isControl = (code: number): boolean => code <= 31 || (code >= 127 && code <= 159);
    for (const line of lines) {
      expect([...line].some((c) => isControl(c.charCodeAt(0))), line).toBe(false);
    }
  });

  it('a name never reorders or breaks a report line: every Cc, Cf, Zl and Zp character (bidi override and isolate, zero-width, line and paragraph separator, BOM, soft hyphen, astral tag) shows escaped; CJK, emoji, accents and quotes print as they are', () => {
    // Every character built from its code (code review R2-F1): an RLO that
    // would visually reverse the rest of the line - the contactId the operator
    // copies into --skip included - isolates, a zero-width space, U+2028 and
    // U+2029 that some viewers break a line at, a BOM at the very end (trim()
    // would eat it raw), a soft hyphen (the one Cf at or below 0xFF) and an
    // astral language tag (the braced form).
    const cp = (code: number): string => String.fromCodePoint(code);
    const BS = cp(92);
    const U = `${BS}u`;
    const report: BackfillReport = {
      ...DRY_REPORT,
      targets: [
        {
          ...lead('c-bidi', `${cp(0x200b)}Ann${cp(0x202e)}eva`, `Lee${cp(0x2066)}x${cp(0x2069)}`, '2026-06-01T09:00:00.000Z', 'needs_review'),
          outcome: 'would_write',
        },
        {
          ...lead('c-sep', `Line${cp(0x2028)}Para${cp(0x2029)}Soft${cp(0xad)}Hy`, `Tag${cp(0xe0001)}${cp(0xfeff)}`, '2026-06-03T09:00:00.000Z', 'needs_review'),
          outcome: 'would_write',
        },
      ],
      leftOut: [
        {
          ...lead('c-keep', `${cp(0x4e2d)}${cp(0x6587)} "Mei"`, `Smile${cp(0x1f600)}${cp(0xe9)}`, '2026-06-04T09:00:00.000Z', 'on_hold'),
          reason: 'skipped',
        },
      ],
    };
    const lines = formatBackfillReport(report, false);
    expect(lines).toEqual([
      'DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):',
      `  ${U}200bAnn${U}202eeva Lee${U}2066x${U}2069  signed up 2026-06-01  status needs_review  contactId c-bidi`,
      `  Line${U}2028Para${U}2029Soft${BS}xadHy Tag${U}{e0001}${U}feff  signed up 2026-06-03  status needs_review  contactId c-sep`,
      'Would update: 2 lead(s). Failed: 0.',
      'Left out (1 lead(s), oldest sign-up first):',
      `  ${cp(0x4e2d)}${cp(0x6587)} "Mei" Smile${cp(0x1f600)}${cp(0xe9)}  signed up 2026-06-04  status on_hold  contactId c-keep  - named in --skip`,
    ]);
    const unsafe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
    for (const line of lines) {
      expect(unsafe.test(line), line).toBe(false);
    }
  });
});

describe('backfillExitCode (spec D10: 0 clean, 1 with failures)', () => {
  it('a completed run exits 0 - warnings included - and 1 once any lead failed', () => {
    expect(backfillExitCode(DRY_REPORT)).toBe(0);
    expect(backfillExitCode({ ...DRY_REPORT, warnings: ['a warning'] })).toBe(0);
    expect(backfillExitCode({ ...DRY_REPORT, failed: 1 })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The reads (spec D10). The DynamoDB Local part self-skips like
// cleanOrgNames.test.ts. No app path creates a candidate any more (every new
// sign-up carries the marker; no seed writes capture_source 'housing_fair'),
// so these tests write pre-change-shaped leads directly.
// ---------------------------------------------------------------------------

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}
const reachable = await endpointReachable();
if (!reachable) console.warn(`[backfillJoinHousingAuthority] SKIPPED - no DynamoDB Local at ${endpoint}.`);

const client = createDynamoClient({ endpoint });
const doc = createDocumentClient({ endpoint });
const created: string[] = [];
const silent = createLogger({ level: 'silent' });
const READ_COMMANDS = new Set(['ScanCommand', 'QueryCommand', 'GetCommand']);
const NO_SKIP: ReadonlySet<string> = new Set();
const LIST_AT = '2026-10-06T00:00:00.000Z';

const NO_LIST_REFUSAL =
  'backfill-join-housing-authority: REFUSED - this environment has no organization list yet: the deployed app creates it on its first read. ' +
  'Open Settings > Housing authorities & agencies once, then re-run. No contact was read and nothing was written.';
const NOT_LISTED_REFUSAL =
  'backfill-join-housing-authority: REFUSED - "Atlanta Housing Authority" is not the exact name of a housing authority on this ' +
  "environment's organization list (renamed, merged, deleted or made an agency). Check Settings > Housing authorities & agencies " +
  'before going on. No contact was read and nothing was written.';
const SKIP_REFUSAL = (ids: string): string =>
  `backfill-join-housing-authority: REFUSED - these --skip ids name no contact on this environment (a typo?): ${ids}. ` +
  "Correct or remove each one (a lead's contactId is the last item on its dry-run line), then re-run. Nothing was written.";
const RUNNING_REFUSAL =
  'backfill-join-housing-authority: REFUSED - an organization-name rewrite is running (action rename, started ' +
  '2026-10-12T12:00:00.000Z, last heartbeat 2026-10-12T12:00:00.000Z). Wait for it to finish (Settings > Housing ' +
  'authorities & agencies shows it); a rewrite whose process was killed stops blocking 15 minutes after its last ' +
  'heartbeat. No contact was read and nothing was written.';

async function dropCreatedTables(): Promise<void> {
  for (const table of created.splice(0)) await deleteTableIfExists(client, table);
}

/** The starting list with fixed ids: Atlanta Housing Authority is a housing_authority entry (lib/orgStartingList.ts). */
function startingEntries(): OrgEntry[] {
  let n = 0;
  return buildStartingEntries(LIST_AT, () => `org-${(n += 1)}`);
}

/** The starting list with its Atlanta Housing Authority entry changed - or removed (null). */
function withAtlanta(change: (entry: OrgEntry) => OrgEntry | null): OrgEntry[] {
  return startingEntries().flatMap((entry) => {
    if (entry.name !== 'Atlanta Housing Authority') return [entry];
    const next = change(entry);
    return next === null ? [] : [next];
  });
}

function listItem(entries: OrgEntry[], lastRewrite?: OrgRewriteState): OrgListItem {
  return { settingId: 'org-list', version: 1, entries, ...(lastRewrite !== undefined && { lastRewrite }) };
}

/** A client that records every command's class name, then sends it for real. */
function recordingClient(inner: DynamoDBDocumentClient): { doc: DynamoDBDocumentClient; sent: string[] } {
  const sent: string[] = [];
  const recording = {
    send: async (command: { constructor: { name: string } }) => {
      sent.push(command.constructor.name);
      return await inner.send(command as never);
    },
    destroy: () => {},
  } as unknown as DynamoDBDocumentClient;
  return { doc: recording, sent };
}

interface World {
  env: NodeJS.ProcessEnv;
  orgList: OrgListRepo;
  /** A contacts row exactly as given. */
  put(item: Record<string, unknown>): Promise<void>;
  /** A pre-change /join lead - the shape the sign-up created before this change - with changes (undefined drops a field). */
  lead(contactId: string, fields?: Record<string, unknown>): Promise<void>;
  /** One audit event with an explicit sort key, so the paging order is fixed. */
  audit(contactId: string, ts: string, eventType: string, payload: Record<string, unknown>): Promise<void>;
  get(contactId: string): Promise<Record<string, unknown> | undefined>;
  scanTable(base: 'contacts' | 'settings' | 'audit_events'): Promise<string[]>;
  backfillEvents(): Promise<Record<string, unknown>[]>;
  /** The housing_authority_backfill_excluded events an --apply recorded. */
  excludedEvents(): Promise<Record<string, unknown>[]>;
  /** The real deps on this world (overridable); `printed` collects the report lines. */
  deps(opts?: { overrides?: Partial<BackfillDeps>; onDoc?: DynamoDBDocumentClient; logger?: Logger }): {
    deps: BackfillDeps;
    printed: string[];
  };
}

/** Fresh contacts, settings and audit tables under their own prefix; the list stored as given (null = none). */
async function newWorld(orgList: OrgListItem | null = listItem(startingEntries())): Promise<World> {
  const env: NodeJS.ProcessEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  for (const base of ['contacts', 'settings', 'audit_events'] as const) {
    await ensureTable(client, getTableSpec(base), tableName(base, env));
    created.push(tableName(base, env));
  }
  const orgListRepo = createOrgListRepo({ doc, env, logger: silent });
  if (orgList !== null) await orgListRepo.putForSeed(orgList);
  const put = async (item: Record<string, unknown>): Promise<void> => {
    await doc.send(new PutCommand({ TableName: tableName('contacts', env), Item: item }));
  };
  const scanItems = async (base: string): Promise<Record<string, unknown>[]> =>
    (await doc.send(new ScanCommand({ TableName: tableName(base, env) }))).Items ?? [];
  return {
    env,
    orgList: orgListRepo,
    put,
    lead: (contactId, fields = {}) =>
      put({
        contactId,
        type: 'tenant',
        status: 'needs_review',
        firstName: 'Lead',
        lastName: contactId,
        capture_source: 'housing_fair',
        captured_at: '2026-07-01T15:00:00.000Z',
        created_at: '2026-07-01T15:00:00.000Z',
        housing_fair_welcomed: true,
        consent_method: 'web_form',
        ...fields,
      }),
    audit: async (contactId, ts, eventType, payload) => {
      await doc.send(
        new PutCommand({
          TableName: tableName('audit_events', env),
          Item: { entityKey: `contacts#${contactId}`, ts, event_type: eventType, payload },
        }),
      );
    },
    get: async (contactId) =>
      (await doc.send(new GetCommand({ TableName: tableName('contacts', env), Key: { contactId } }))).Item,
    scanTable: async (base) => (await scanItems(base)).map((item) => JSON.stringify(item)).sort(),
    backfillEvents: async () => (await scanItems('audit_events')).filter((e) => e['event_type'] === BACKFILL_AUDIT_TYPE),
    excludedEvents: async () =>
      (await scanItems('audit_events')).filter((e) => e['event_type'] === BACKFILL_EXCLUDED_AUDIT_TYPE),
    deps: (opts = {}) => {
      const printed: string[] = [];
      const deps: BackfillDeps = {
        ...buildBackfillDeps(
          { doc: opts.onDoc ?? doc, env },
          { logger: opts.logger ?? silent, print: (line) => printed.push(line) },
        ),
        ...opts.overrides,
      };
      return { deps, printed };
    },
  };
}

describe('checkBackfillList - the refusals, before any contact is read (spec D10)', () => {
  const AT = '2026-10-12T12:00:00.000Z';
  const running: OrgRewriteState = {
    jobId: 'job-rename',
    action: 'rename',
    fromTexts: ['Old Name'],
    fields: ['housingAuthority', 'accepted_authorities'],
    toName: 'New Name',
    status: 'running',
    heartbeatAt: AT,
    startedAt: AT,
    startedBy: 'user-0001',
  };
  const on = (item: OrgListItem | null, nowIso = AT): Pick<BackfillDeps, 'orgList' | 'now'> => ({
    orgList: { peek: async () => item },
    now: () => Date.parse(nowIso),
  });
  const outcomeOf = (deps: Pick<BackfillDeps, 'orgList' | 'now'>, apply: boolean): Promise<unknown> =>
    checkBackfillList(deps, apply).then(
      () => 'passed',
      (err: unknown) => err,
    );

  it('passes a stored list that names Atlanta Housing Authority exactly - for a dry run and an apply', async () => {
    expect(await outcomeOf(on(listItem(startingEntries())), false)).toBe('passed');
    expect(await outcomeOf(on(listItem(startingEntries())), true)).toBe('passed');
  });

  it('refuses when no list is stored - a dry run too: it never falls back to the starting list', async () => {
    for (const apply of [false, true]) {
      const outcome = await outcomeOf(on(null), apply);
      expect(outcome).toBeInstanceOf(BackfillRefusedError);
      expect((outcome as Error).message).toBe(NO_LIST_REFUSAL);
    }
  });

  const notExact: Array<[string, OrgEntry[]]> = [
    ['renamed', withAtlanta((e) => ({ ...e, name: 'Atlanta Housing Authority (AHA)' }))],
    ['in another case', withAtlanta((e) => ({ ...e, name: 'atlanta housing authority' }))],
    ['made an agency', withAtlanta((e) => ({ ...e, kind: 'agency' }))],
    [
      'only a spelling of another name',
      withAtlanta((e) => ({ ...e, name: 'Housing Authority of the City of Atlanta', spellings: ['Atlanta Housing Authority'] })),
    ],
    ['deleted', withAtlanta(() => null)],
  ];
  it.each(notExact)('refuses when Atlanta Housing Authority is not an exact housing authority name: %s', async (_what, entries) => {
    for (const apply of [false, true]) {
      const outcome = await outcomeOf(on(listItem(entries)), apply);
      expect(outcome).toBeInstanceOf(BackfillRefusedError);
      expect((outcome as Error).message).toBe(NOT_LISTED_REFUSAL);
    }
  });

  it('refuses an apply while a rewrite is running (heartbeat 5 minutes old); a dry run goes ahead', async () => {
    const deps = on(listItem(startingEntries(), running), '2026-10-12T12:05:00.000Z');
    const outcome = await outcomeOf(deps, true);
    expect(outcome).toBeInstanceOf(BackfillRefusedError);
    expect((outcome as Error).message).toBe(RUNNING_REFUSAL);
    expect(await outcomeOf(deps, false)).toBe('passed');
  });

  it('a STALE running rewrite (no heartbeat for over 15 minutes) does not refuse an apply; nor does a finished one', async () => {
    expect(await outcomeOf(on(listItem(startingEntries(), running), '2026-10-12T12:16:00.000Z'), true)).toBe('passed');
    for (const status of ['done', 'failed'] as const) {
      expect(await outcomeOf(on(listItem(startingEntries(), { ...running, status }), '2026-10-12T12:01:00.000Z'), true)).toBe(
        'passed',
      );
    }
  });
});

describe('readWholeHistory and leftOutReasonFor (pure seams)', () => {
  it('stops with an error rather than loop forever on a store whose pages do not move back', async () => {
    const stuck = { listByEntity: async () => [event('contact_updated', { fields: ['status'] })] };
    await expect(readWholeHistory(stuck, 'contacts#c-lead', 2)).rejects.toThrow('audit history paging did not advance');
  });

  it('a lead named in --skip is left out - and its history is still read, so an --apply knows whether its exclusion is already recorded', async () => {
    const reads: string[] = [];
    const histories: Record<string, AuditEvent[]> = {
      'contacts#c-excluded': [{ ...event(BACKFILL_EXCLUDED_AUDIT_TYPE, { field: 'housingAuthority' }), entityKey: 'contacts#c-excluded' }],
    };
    const audit: BackfillDeps['audit'] = {
      append: async () => {},
      listByEntity: async (entityKey, opts) => {
        reads.push(entityKey);
        return opts?.before === undefined ? (histories[entityKey] ?? []) : [];
      },
    };
    const skip = new Set(['c-skip', 'c-excluded']);
    expect(await leftOutReasonFor({ audit }, 'c-skip', skip)).toEqual({ reason: 'skipped', exclusionRecorded: false });
    expect(await leftOutReasonFor({ audit }, 'c-excluded', skip)).toEqual({ reason: 'skipped', exclusionRecorded: true });
    // Without --skip on this run, the recorded exclusion leaves it out by itself.
    expect(await leftOutReasonFor({ audit }, 'c-excluded', new Set())).toEqual({
      reason: 'excluded_earlier',
      exclusionRecorded: true,
    });
    expect(await leftOutReasonFor({ audit }, 'c-other', skip)).toEqual({ reason: null, exclusionRecorded: false });
    // Every lead's history read to its end (a page, then the empty page) - the --skip ones included.
    expect(reads).toEqual([
      'contacts#c-skip',
      'contacts#c-excluded',
      'contacts#c-excluded',
      'contacts#c-excluded',
      'contacts#c-excluded',
      'contacts#c-other',
    ]);
  });
});

describe.skipIf(!reachable)('the reads against DynamoDB Local (spec D10)', () => {
  afterEach(dropCreatedTables, 120_000);

  it('scanCandidates selects exactly the pre-change /join leads - each condition, pointer rows skipped - oldest sign-up first', async () => {
    const w = await newWorld();
    await w.lead('c-new', { captured_at: '2026-08-15T23:30:00.000Z', status: 'on_hold' });
    await w.lead('c-old', { captured_at: '2026-06-20T14:00:00.000Z' });
    // No captured_at: the sign-up date is created_at.
    await w.lead('c-created-only', { captured_at: undefined, created_at: '2026-07-04T10:00:00.000Z', status: 'inactive' });
    // No date at all: listed last.
    await w.lead('c-undated', { captured_at: undefined, created_at: undefined });
    // Not candidates - one condition each.
    await w.lead('c-flyer', { capture_source: 'flyer', unit_of_interest: 'u-1' });
    await w.lead('c-inbound', { capture_source: 'inbound_sms' });
    await w.lead('c-no-source', { capture_source: undefined });
    await w.lead('c-landlord', { type: 'landlord', status: 'active' });
    await w.lead('c-partner', { type: 'partner', status: 'active', role: 'Caseworker' });
    await w.lead('c-deleted', { deleted_at: '2026-09-01T00:00:00.000Z' });
    await w.lead('c-has-authority', { housingAuthority: 'DeKalb County Housing Authority' });
    await w.lead('c-has-atlanta', { housingAuthority: 'Atlanta Housing Authority' });
    await w.lead('c-marker', { housing_fair_signup_v2: true, status: 'onboarding' });
    // Pointer rows are skipped by their id prefix, whatever they carry.
    await w.put({
      contactId: 'phoneref#+15550001001',
      phone: '+15550001001',
      phone_ref: true,
      phone_ref_owner: 'c-old',
      capture_source: 'housing_fair',
      type: 'tenant',
    });
    await w.put({
      contactId: 'emailref#lead@example.com',
      email: 'lead@example.com',
      email_ref: true,
      email_ref_owner: 'c-old',
      capture_source: 'housing_fair',
      type: 'tenant',
    });

    const { deps } = w.deps();
    const scan = await scanCandidates(deps);
    expect(scan.leads.map((l) => l.contactId)).toEqual(['c-old', 'c-created-only', 'c-new', 'c-undated']);
    expect(scan.leads[0]).toEqual({
      contactId: 'c-old',
      firstName: 'Lead',
      lastName: 'c-old',
      signedUpAt: '2026-06-20T14:00:00.000Z',
      status: 'needs_review',
    });
    expect(scan.leads[1]).toMatchObject({ signedUpAt: '2026-07-04T10:00:00.000Z', status: 'inactive' });
    expect(scan.leads[2]).toMatchObject({ signedUpAt: '2026-08-15T23:30:00.000Z', status: 'on_hold' });
    expect(scan.leads[3]).toMatchObject({ signedUpAt: '' });
    expect(scan).toMatchObject({ contactsScanned: 13, pointerRows: 2 });
    // Every contact's id - deleted ones included, pointer rows not: the --skip check's set.
    expect([...scan.contactIds].sort()).toEqual(
      [
        'c-new',
        'c-old',
        'c-created-only',
        'c-undated',
        'c-flyer',
        'c-inbound',
        'c-no-source',
        'c-landlord',
        'c-partner',
        'c-deleted',
        'c-has-authority',
        'c-has-atlanta',
        'c-marker',
      ].sort(),
    );
    // The Scan paging loop: two rows a page finds the same leads.
    expect(await scanCandidates({ ...deps, scanLimit: 2 })).toEqual(scan);
  }, 120_000);

  it('leftOutReasonFor reads every recorded shape through the store: a set or removed authority, a post-change sign-up and an earlier exclusion leave a lead out; nothing else does', async () => {
    const w = await newWorld();
    const ts = '2026-08-01T12:00:00.000Z#aaaa0001';
    for (const [i, [, type, payload]] of AUTHORITY_EVENTS.entries()) await w.audit(`c-auth-${i}`, ts, type, payload);
    for (const [i, [, type, payload]] of UNRELATED_EVENTS.entries()) await w.audit(`c-other-${i}`, ts, type, payload);
    await w.audit('c-again', ts, 'housing_fair_signup', RESIGNUP_PAYLOAD);
    await w.audit('c-excluded', ts, BACKFILL_EXCLUDED_AUDIT_TYPE, { field: 'housingAuthority' });
    const { deps } = w.deps();
    const reasonOf = async (contactId: string): Promise<string | null> => (await leftOutReasonFor(deps, contactId, NO_SKIP)).reason;
    for (const [i, [what]] of AUTHORITY_EVENTS.entries()) {
      expect([what, await reasonOf(`c-auth-${i}`)]).toEqual([what, 'authority_history']);
    }
    for (const [i, [what]] of UNRELATED_EVENTS.entries()) {
      expect([what, await reasonOf(`c-other-${i}`)]).toEqual([what, null]);
    }
    expect(await reasonOf('c-again')).toBe('signed_up_again');
    expect(await leftOutReasonFor(deps, 'c-excluded', NO_SKIP)).toEqual({ reason: 'excluded_earlier', exclusionRecorded: true });
    expect(await reasonOf('c-no-history')).toBeNull();
  }, 120_000);

  it('the precedence through the store: --skip over an earlier exclusion, an earlier exclusion over the history', async () => {
    const w = await newWorld();
    // Both an earlier exclusion and a later staff edit that set and cleared the authority.
    await w.audit('c-both', '2026-08-01T12:00:00.000Z#aaaa0001', BACKFILL_EXCLUDED_AUDIT_TYPE, { field: 'housingAuthority' });
    await w.audit('c-both', '2026-08-02T12:00:00.000Z#aaaa0001', 'contact_updated', { fields: ['housingAuthority'], actor: 'user-0001' });
    await w.audit('c-both', '2026-08-03T12:00:00.000Z#aaaa0001', 'housing_fair_signup', RESIGNUP_PAYLOAD);
    const { deps } = w.deps();
    expect(await leftOutReasonFor(deps, 'c-both', new Set(['c-both']))).toEqual({ reason: 'skipped', exclusionRecorded: true });
    expect(await leftOutReasonFor(deps, 'c-both', NO_SKIP)).toEqual({ reason: 'excluded_earlier', exclusionRecorded: true });
  }, 120_000);

  it('leftOutReasonFor pages backward past one page until a page comes back empty: an event on the OLDEST page still counts', async () => {
    const w = await newWorld();
    // Oldest first: the staff edit that cleared the authority, then four unrelated edits.
    await w.audit('c-deep', '2026-07-01T10:00:00.000Z#aaaa0001', 'contact_updated', {
      fields: ['housingAuthority'],
      actor: 'user-0001',
    });
    const later = ['2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'];
    for (const [i, day] of later.entries()) {
      const payload = { fields: ['status'], actor: 'user-0001' };
      await w.audit('c-deep', `${day}T10:00:00.000Z#bbbb000${i}`, 'contact_updated', payload);
      await w.audit('c-clean', `${day}T10:00:00.000Z#bbbb000${i}`, 'contact_updated', payload);
    }
    const { deps } = w.deps();
    const befores: Array<string | undefined> = [];
    const audit: BackfillDeps['audit'] = {
      append: (entityKey, eventType, payload) => deps.audit.append(entityKey, eventType, payload),
      listByEntity: (entityKey, opts) => {
        if (entityKey === 'contacts#c-deep') befores.push(opts?.before);
        return deps.audit.listByEntity(entityKey, opts);
      },
    };
    expect((await leftOutReasonFor({ audit, auditPageSize: 2 }, 'c-deep', NO_SKIP)).reason).toBe('authority_history');
    // Pages of two, newest first: [07-05, 07-04], [07-03, 07-02], [07-01], then the empty page that ends it.
    expect(befores).toEqual([
      undefined,
      '2026-07-04T10:00:00.000Z#bbbb0002',
      '2026-07-02T10:00:00.000Z#bbbb0000',
      '2026-07-01T10:00:00.000Z#aaaa0001',
    ]);
    // A long history with nothing in it is read to its end too.
    expect((await leftOutReasonFor({ audit, auditPageSize: 2 }, 'c-clean', NO_SKIP)).reason).toBeNull();
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The run (spec D10): dry run by default, --apply writes
// ---------------------------------------------------------------------------

const RENAMED_WARNING = (written: number): string =>
  '"Atlanta Housing Authority" is no longer the exact name of a housing authority on the organization list (renamed, ' +
  `merged away, deleted or made an agency during the run): the ${written} record(s) written show under Settings > ` +
  'Housing authorities & agencies > "Not on the list" - settle them there.';
const REREAD_WARNING =
  'the organization list could not be read again after the apply, so the run could not confirm "Atlanta Housing ' +
  'Authority" is still on it - check Settings > Housing authorities & agencies > "Not on the list".';
const AUDIT_WARNING = (contactId: string): string =>
  `the housing_authority_backfill audit event for contactId ${contactId} could not be written (its housing authority was set).`;

/**
 * The world the run tests share. Targets: c-old, c-mid, c-new. Left out:
 * c-skip (the tests name it in --skip), c-again (signed up again after the
 * change), c-cleared (staff cleared its authority once). Not candidates:
 * c-marker, c-held, c-flyer.
 */
async function seedLeads(w: World): Promise<void> {
  await w.lead('c-old', { firstName: 'Avery', lastName: 'Fairlead', captured_at: '2026-06-20T14:00:00.000Z' });
  // A sign-up from BEFORE the change leaves no one out.
  await w.audit('c-old', '2026-06-20T14:00:01.000Z#aaaa0001', 'housing_fair_signup', {
    marker: 'mk',
    isNew: true,
    welcomeSent: true,
    viaFlyer: false,
  });
  await w.lead('c-mid', {
    firstName: 'Blake',
    lastName: 'Boothwick',
    captured_at: undefined,
    created_at: '2026-07-04T10:00:00.000Z',
    status: 'on_hold',
  });
  await w.lead('c-new', {
    firstName: 'Casey',
    lastName: 'Quillfeather',
    captured_at: '2026-08-15T23:30:00.000Z',
    status: 'onboarding',
  });
  await w.lead('c-skip', { firstName: 'Drew', lastName: 'Dekalbson', captured_at: '2026-06-01T09:00:00.000Z' });
  await w.lead('c-again', { firstName: 'Emery', lastName: 'Again', captured_at: '2026-06-10T09:00:00.000Z' });
  await w.audit('c-again', '2026-10-13T15:00:00.000Z#aaaa0001', 'housing_fair_signup', RESIGNUP_PAYLOAD);
  await w.lead('c-cleared', { firstName: 'Finley', lastName: 'Cleared', captured_at: '2026-07-10T09:00:00.000Z' });
  await w.audit('c-cleared', '2026-07-20T15:00:00.000Z#aaaa0001', 'contact_updated', {
    fields: ['housingAuthority'],
    actor: 'user-0001',
  });
  await w.lead('c-marker', { housing_fair_signup_v2: true, status: 'onboarding' });
  await w.lead('c-held', { housingAuthority: 'DeKalb County Housing Authority' });
  await w.lead('c-flyer', { capture_source: 'flyer' });
}

const TARGET_LEADS: BackfillLead[] = [
  { contactId: 'c-old', firstName: 'Avery', lastName: 'Fairlead', signedUpAt: '2026-06-20T14:00:00.000Z', status: 'needs_review' },
  { contactId: 'c-mid', firstName: 'Blake', lastName: 'Boothwick', signedUpAt: '2026-07-04T10:00:00.000Z', status: 'on_hold' },
  { contactId: 'c-new', firstName: 'Casey', lastName: 'Quillfeather', signedUpAt: '2026-08-15T23:30:00.000Z', status: 'onboarding' },
];
const LEFT_OUT = [
  {
    contactId: 'c-skip',
    firstName: 'Drew',
    lastName: 'Dekalbson',
    signedUpAt: '2026-06-01T09:00:00.000Z',
    status: 'needs_review',
    reason: 'skipped',
  },
  {
    contactId: 'c-again',
    firstName: 'Emery',
    lastName: 'Again',
    signedUpAt: '2026-06-10T09:00:00.000Z',
    status: 'needs_review',
    reason: 'signed_up_again',
  },
  {
    contactId: 'c-cleared',
    firstName: 'Finley',
    lastName: 'Cleared',
    signedUpAt: '2026-07-10T09:00:00.000Z',
    status: 'needs_review',
    reason: 'authority_history',
  },
];
const SKIP: ReadonlySet<string> = new Set(['c-skip']);
const GUARDED_WRITE = {
  expect: [
    { attr: 'housingAuthority', value: null },
    { attr: 'type', value: 'tenant' },
  ],
  notDeleted: true,
};

const freshRewrite = (): OrgRewriteState => {
  const at = new Date().toISOString();
  return {
    jobId: 'job-rename',
    action: 'rename',
    fromTexts: ['Old Name'],
    fields: ['housingAuthority', 'accepted_authorities'],
    toName: 'New Name',
    status: 'running',
    heartbeatAt: at,
    startedAt: at,
    startedBy: 'user-0001',
  };
};

describe.skipIf(!reachable)('runJoinAuthorityBackfill against DynamoDB Local (spec D10)', () => {
  afterEach(dropCreatedTables, 120_000);

  it('dry run: the targets and the left-out leads oldest first, the unknown --skip ids and the printed report - and NOTHING written, not even the list item', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const before = {
      contacts: await w.scanTable('contacts'),
      settings: await w.scanTable('settings'),
      audit: await w.scanTable('audit_events'),
    };
    const recorder = recordingClient(doc);
    const { deps, printed } = w.deps({ onDoc: recorder.doc });
    const report = await runJoinAuthorityBackfill(deps, { apply: false, skip: new Set(['c-skip', 'c-flyer', 'c-nobody']) });
    expect(report).toEqual({
      targets: TARGET_LEADS.map((l) => ({ ...l, outcome: 'would_write' })),
      leftOut: LEFT_OUT,
      // c-flyer is a contact but no candidate (ignored); c-nobody names no contact (an --apply would refuse).
      unknownSkips: ['c-flyer'],
      missingSkips: ['c-nobody'],
      written: 0,
      skipped: 0,
      failed: 0,
      warnings: [],
    });
    expect(printed).toEqual(formatBackfillReport(report, false));
    expect(printed[1]).toBe('  Avery Fairlead  signed up 2026-06-20  status needs_review  contactId c-old');
    expect(printed).toContain('--skip id that names no contact (a typo?) - an --apply refuses to run with it: c-nobody');
    // WRITES NOTHING, three ways: only reads were sent, the list was read once, no item changed.
    expect(recorder.sent).toContain('ScanCommand');
    expect(recorder.sent.filter((name) => !READ_COMMANDS.has(name))).toEqual([]);
    expect(recorder.sent.filter((name) => name === 'GetCommand')).toHaveLength(1);
    expect(await w.scanTable('contacts')).toEqual(before.contacts);
    expect(await w.scanTable('settings')).toEqual(before.settings);
    expect(await w.scanTable('audit_events')).toEqual(before.audit);
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it('apply: one guarded write and one audit event per target, nothing else changed; a re-run writes nothing new', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const leftAlone = ['c-skip', 'c-again', 'c-cleared', 'c-marker', 'c-held', 'c-flyer'];
    const before = new Map(await Promise.all(leftAlone.map(async (id) => [id, await w.get(id)] as const)));
    const oldBefore = await w.get('c-old');
    const recorder = recordingClient(doc);
    const base = w.deps({ onDoc: recorder.doc });
    const updates: unknown[] = [];
    const deps: BackfillDeps = {
      ...base.deps,
      contacts: {
        update: async (contactId, patch, opts) => {
          updates.push([contactId, patch, opts]);
          return base.deps.contacts.update(contactId, patch, opts);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report).toEqual({
      targets: TARGET_LEADS.map((l) => ({ ...l, outcome: 'written' })),
      leftOut: LEFT_OUT,
      unknownSkips: [],
      missingSkips: [],
      written: 3,
      skipped: 0,
      failed: 0,
      warnings: [],
    });
    expect(base.printed).toEqual(formatBackfillReport(report, true));
    // The binding write (plan section 1): contactsRepo.update with the three guards.
    expect(updates).toEqual([
      ['c-old', { housingAuthority: 'Atlanta Housing Authority' }, GUARDED_WRITE],
      ['c-mid', { housingAuthority: 'Atlanta Housing Authority' }, GUARDED_WRITE],
      ['c-new', { housingAuthority: 'Atlanta Housing Authority' }, GUARDED_WRITE],
    ]);
    // The ONE change is the authority: status and every other attribute exactly as before.
    expect(await w.get('c-old')).toEqual({ ...oldBefore, housingAuthority: 'Atlanta Housing Authority' });
    expect(await w.get('c-mid')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority', status: 'on_hold' });
    expect(await w.get('c-new')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority', status: 'onboarding' });
    for (const id of leftAlone) expect(await w.get(id)).toEqual(before.get(id));
    // One housing_authority_backfill event per target: exactly { field, from: '', to }, no actor.
    const events = await w.backfillEvents();
    expect(events.map((e) => e['entityKey']).sort()).toEqual(['contacts#c-mid', 'contacts#c-new', 'contacts#c-old']);
    for (const e of events) {
      expect(e['payload']).toEqual({ field: 'housingAuthority', from: '', to: 'Atlanta Housing Authority' });
      expect(e['actorId']).toBeUndefined();
    }
    // Two list reads: the check before, the re-read after (still listed: no warning).
    expect(recorder.sent.filter((name) => name === 'GetCommand')).toHaveLength(2);
    // The --skip lead's exclusion is recorded: ONE event { field } with no actor - and nothing on any other lead.
    const excluded = await w.excludedEvents();
    expect(excluded.map((e) => [e['entityKey'], e['payload'], e['actorId']])).toEqual([
      ['contacts#c-skip', { field: 'housingAuthority' }, undefined],
    ]);
    expect(backfillExitCode(report)).toBe(0);

    // A re-run with the same --skip writes nothing new - no second exclusion either.
    const again = await runJoinAuthorityBackfill(w.deps().deps, { apply: true, skip: SKIP });
    expect(again).toMatchObject({ targets: [], written: 0, skipped: 0, failed: 0, warnings: [] });
    expect(again.leftOut.map((l) => [l.contactId, l.reason])).toEqual([
      ['c-skip', 'skipped'],
      ['c-again', 'signed_up_again'],
      ['c-cleared', 'authority_history'],
    ]);
    expect(await w.backfillEvents()).toHaveLength(3);
    expect(await w.excludedEvents()).toHaveLength(1);
    // A later run WITHOUT the --skip - a dry run and an apply - leaves the excluded lead out: the apply remembered it.
    const { deps: dryDeps, printed: dryPrinted } = w.deps();
    const noSkip = await runJoinAuthorityBackfill(dryDeps, { apply: false, skip: new Set() });
    expect(noSkip.targets).toEqual([]);
    expect(noSkip.leftOut.map((l) => [l.contactId, l.reason])).toEqual([
      ['c-skip', 'excluded_earlier'],
      ['c-again', 'signed_up_again'],
      ['c-cleared', 'authority_history'],
    ]);
    expect(dryPrinted).toContain(
      '  Drew Dekalbson  signed up 2026-06-01  status needs_review  contactId c-skip  - excluded on an earlier run',
    );
    const applyNoSkip = await runJoinAuthorityBackfill(w.deps().deps, { apply: true, skip: new Set() });
    expect(applyNoSkip).toMatchObject({ targets: [], written: 0, failed: 0 });
    expect((await w.get('c-skip'))?.['housingAuthority']).toBeUndefined();
    expect(await w.excludedEvents()).toHaveLength(1);
  }, 120_000);

  it('an exclusion that cannot be recorded is a FAILED left-out line: the lead is still left out, the run goes on, exit 1 - and a re-run with the same --skip records it', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const base = w.deps({ logger: log });
    const deps: BackfillDeps = {
      ...base.deps,
      audit: {
        listByEntity: (entityKey, opts) => base.deps.audit.listByEntity(entityKey, opts),
        append: async (entityKey, eventType, payload) => {
          if (eventType === BACKFILL_EXCLUDED_AUDIT_TYPE) throw new Error('ProvisionedThroughputExceededException');
          await base.deps.audit.append(entityKey, eventType, payload);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report).toMatchObject({ written: 3, skipped: 0, failed: 1, warnings: [] });
    expect(report.leftOut[0]).toEqual({ ...LEFT_OUT[0], exclusionFailed: true });
    expect(base.printed).toContain(
      '  Drew Dekalbson  signed up 2026-06-01  status needs_review  contactId c-skip  - named in --skip - FAILED: its exclusion could not be recorded (an ERROR line names this contactId) - keep it in --skip and re-run the apply',
    );
    expect(base.printed).toContain('Written: 3. Skipped (changed after the read): 0. Failed: 1.');
    expect((await w.get('c-skip'))?.['housingAuthority']).toBeUndefined();
    expect(await w.excludedEvents()).toEqual([]);
    expect(capture.atLevel(50).map((l) => l['contactId'])).toEqual(['c-skip']);
    expect(capture.lines.some((l) => JSON.stringify(l).includes('Dekalbson'))).toBe(false);
    expect(backfillExitCode(report)).toBe(1);

    const again = await runJoinAuthorityBackfill(w.deps().deps, { apply: true, skip: SKIP });
    expect(again).toMatchObject({ written: 0, failed: 0 });
    expect((await w.excludedEvents()).map((e) => e['entityKey'])).toEqual(['contacts#c-skip']);
  }, 120_000);

  it('an exclusion recorded by an earlier --apply is not recorded twice when the lead is named in --skip again', async () => {
    const w = await newWorld();
    await seedLeads(w);
    await w.audit('c-skip', '2026-10-01T12:00:00.000Z#aaaa0001', BACKFILL_EXCLUDED_AUDIT_TYPE, { field: 'housingAuthority' });
    const report = await runJoinAuthorityBackfill(w.deps().deps, { apply: true, skip: SKIP });
    // --skip on this run is the reason printed; the history already holds the exclusion.
    expect(report.leftOut[0]).toEqual(LEFT_OUT[0]);
    expect(report).toMatchObject({ written: 3, failed: 0 });
    expect((await w.excludedEvents()).map((e) => e['ts'])).toEqual(['2026-10-01T12:00:00.000Z#aaaa0001']);
  }, 120_000);

  it('a lead that changed between the read and the write is skipped, never overwritten - each guard: authority, type, deleted', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const base = w.deps();
    const key = (contactId: string) => ({ TableName: tableName('contacts', w.env), Key: { contactId } });
    const deps: BackfillDeps = {
      ...base.deps,
      contacts: {
        update: async (contactId, patch, opts) => {
          // Staff acted after the run read the lead.
          if (contactId === 'c-old') {
            await doc.send(
              new UpdateCommand({
                ...key(contactId),
                UpdateExpression: 'SET housingAuthority = :v',
                ExpressionAttributeValues: { ':v': 'DeKalb County Housing Authority' },
              }),
            );
          }
          if (contactId === 'c-mid') {
            await doc.send(
              new UpdateCommand({
                ...key(contactId),
                UpdateExpression: 'SET #t = :v',
                ExpressionAttributeNames: { '#t': 'type' },
                ExpressionAttributeValues: { ':v': 'landlord' },
              }),
            );
          }
          if (contactId === 'c-new') {
            await doc.send(
              new UpdateCommand({
                ...key(contactId),
                UpdateExpression: 'SET deleted_at = :v',
                ExpressionAttributeValues: { ':v': '2026-10-13T00:00:00.000Z' },
              }),
            );
          }
          return base.deps.contacts.update(contactId, patch, opts);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report.targets.map((t) => [t.contactId, t.outcome])).toEqual([
      ['c-old', 'skipped'],
      ['c-mid', 'skipped'],
      ['c-new', 'skipped'],
    ]);
    expect(report).toMatchObject({ written: 0, skipped: 3, failed: 0, warnings: [] });
    expect(await w.get('c-old')).toMatchObject({ housingAuthority: 'DeKalb County Housing Authority' });
    expect((await w.get('c-mid'))?.['housingAuthority']).toBeUndefined();
    expect((await w.get('c-new'))?.['housingAuthority']).toBeUndefined();
    expect(await w.backfillEvents()).toEqual([]);
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it('a lead whose history read or write fails is counted failed and the run goes on: exit 1, no name in any log line - a failed READ says nothing was written, a failed WRITE never does', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const base = w.deps({ logger: log });
    const deps: BackfillDeps = {
      ...base.deps,
      contacts: {
        update: async (contactId, patch, opts) => {
          if (contactId === 'c-mid') throw new Error('ProvisionedThroughputExceededException');
          return base.deps.contacts.update(contactId, patch, opts);
        },
      },
      audit: {
        append: (entityKey, eventType, payload) => base.deps.audit.append(entityKey, eventType, payload),
        listByEntity: async (entityKey, opts) => {
          if (entityKey === 'contacts#c-new') throw new Error('ThrottlingException');
          return base.deps.audit.listByEntity(entityKey, opts);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report.targets.map((t) => [t.contactId, t.outcome])).toEqual([
      ['c-old', 'written'],
      ['c-mid', 'write_failed'],
      ['c-new', 'read_failed'],
    ]);
    expect(report).toMatchObject({ written: 1, skipped: 0, failed: 2 });
    expect((await w.get('c-mid'))?.['housingAuthority']).toBeUndefined();
    expect((await w.get('c-new'))?.['housingAuthority']).toBeUndefined();
    expect(base.printed).toContain(
      '  Blake Boothwick  signed up 2026-07-04  status on_hold  contactId c-mid  - FAILED: the write may or may not have landed (an ERROR line names this contactId) - re-run the dry run to see',
    );
    expect(base.printed).toContain(
      '  Casey Quillfeather  signed up 2026-08-15  status onboarding  contactId c-new  - FAILED: nothing written (an ERROR line names this contactId); re-run',
    );
    const errors = capture.atLevel(50);
    expect(errors.map((l) => l['contactId']).sort()).toEqual(['c-mid', 'c-new']);
    const errorMsg = (contactId: string): string => String(errors.find((l) => l['contactId'] === contactId)?.['msg']);
    expect(errorMsg('c-mid')).toBe('backfill-join-housing-authority - the write FAILED; it may or may not have landed - re-run the dry run to see');
    expect(errorMsg('c-new')).toContain('nothing written for this contact');
    const done = capture.atLevel(40).find((l) => String(l['msg']).includes('COMPLETED WITH FAILURES'));
    expect(done).toBeDefined();
    // The run-level line covers a write that may have landed: it never says nothing was written.
    for (const line of [errorMsg('c-mid'), String(done?.['msg'])]) {
      expect(line).not.toContain('nothing written');
      expect(line).not.toContain('left as they were');
    }
    // Names reach the printed report only - never a structured log line.
    expect(base.printed.some((l) => l.includes('Avery Fairlead'))).toBe(true);
    for (const name of ['Fairlead', 'Boothwick', 'Quillfeather']) {
      expect(capture.lines.some((l) => JSON.stringify(l).includes(name))).toBe(false);
    }
    expect(backfillExitCode(report)).toBe(1);
  }, 120_000);

  it('a write error AFTER the write landed (an ambiguous error such as a timeout) is a write_failed line, and the dry run shows where the lead stands', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const base = w.deps();
    const deps: BackfillDeps = {
      ...base.deps,
      contacts: {
        update: async (contactId, patch, opts) => {
          const landed = await base.deps.contacts.update(contactId, patch, opts);
          if (contactId === 'c-mid') throw new Error('TimeoutError: socket hang up');
          return landed;
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report.targets.map((t) => [t.contactId, t.outcome])).toEqual([
      ['c-old', 'written'],
      ['c-mid', 'write_failed'],
      ['c-new', 'written'],
    ]);
    expect(report).toMatchObject({ written: 2, failed: 1 });
    expect(base.printed.join('\n')).not.toContain('nothing written (an ERROR');
    // It DID land: the lead holds the authority, and the next dry run no longer lists it.
    expect(await w.get('c-mid')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority' });
    const dry = await runJoinAuthorityBackfill(w.deps().deps, { apply: false, skip: SKIP });
    expect(dry.targets).toEqual([]);
    expect(backfillExitCode(report)).toBe(1);
  }, 120_000);

  it('an audit event that cannot be written after its write landed is a WARNING, not a failure: exit 0', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const base = w.deps();
    const deps: BackfillDeps = {
      ...base.deps,
      audit: {
        listByEntity: (entityKey, opts) => base.deps.audit.listByEntity(entityKey, opts),
        append: async (entityKey, eventType, payload) => {
          if (entityKey === 'contacts#c-mid') throw new Error('Rate exceeded');
          await base.deps.audit.append(entityKey, eventType, payload);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report).toMatchObject({ written: 3, failed: 0, warnings: [AUDIT_WARNING('c-mid')] });
    expect(await w.get('c-mid')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority' });
    expect((await w.backfillEvents()).map((e) => e['entityKey']).sort()).toEqual(['contacts#c-new', 'contacts#c-old']);
    expect(base.printed).toContain(`WARNING: ${AUDIT_WARNING('c-mid')}`);
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it('warns after an apply when Atlanta Housing Authority left the list during the run (renamed) - the writes stand, exit 0', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const base = w.deps();
    let renamed = false;
    const deps: BackfillDeps = {
      ...base.deps,
      contacts: {
        update: async (contactId, patch, opts) => {
          if (!renamed) {
            renamed = true;
            await w.orgList.putForSeed(listItem(withAtlanta((e) => ({ ...e, name: 'Atlanta Housing Authority (AHA)' }))));
          }
          return base.deps.contacts.update(contactId, patch, opts);
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report.written).toBe(3);
    expect(report.warnings).toEqual([RENAMED_WARNING(3)]);
    expect(base.printed.at(-1)).toBe(`WARNING: ${RENAMED_WARNING(3)}`);
    expect(await w.get('c-old')).toMatchObject({ housingAuthority: 'Atlanta Housing Authority' });
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it('warns when the list cannot be read again after the apply - the writes stand, exit 0', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const base = w.deps();
    let peeks = 0;
    const deps: BackfillDeps = {
      ...base.deps,
      orgList: {
        peek: async () => {
          peeks += 1;
          if (peeks > 1) throw new Error('settings table unavailable');
          return base.deps.orgList.peek();
        },
      },
    };
    const report = await runJoinAuthorityBackfill(deps, { apply: true, skip: SKIP });
    expect(report).toMatchObject({ written: 3, failed: 0, warnings: [REREAD_WARNING] });
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it.each([
    { what: 'no organization list is stored (a dry run)', list: (): OrgListItem | null => null, apply: false },
    {
      what: 'Atlanta Housing Authority was renamed (a dry run)',
      list: (): OrgListItem | null => listItem(withAtlanta((e) => ({ ...e, name: 'Atlanta Housing Authority (AHA)' }))),
      apply: false,
    },
    {
      what: 'a rewrite is running (an apply)',
      list: (): OrgListItem | null => listItem(startingEntries(), freshRewrite()),
      apply: true,
    },
  ])('refuses before reading any contact when $what: one list read, nothing written, nothing printed', async ({ list, apply }) => {
    const w = await newWorld(list());
    await seedLeads(w);
    const before = {
      contacts: await w.scanTable('contacts'),
      settings: await w.scanTable('settings'),
      audit: await w.scanTable('audit_events'),
    };
    const recorder = recordingClient(doc);
    const { deps, printed } = w.deps({ onDoc: recorder.doc });
    await expect(runJoinAuthorityBackfill(deps, { apply, skip: NO_SKIP })).rejects.toBeInstanceOf(BackfillRefusedError);
    expect(recorder.sent).toEqual(['GetCommand']);
    expect(printed).toEqual([]);
    expect(await w.scanTable('contacts')).toEqual(before.contacts);
    expect(await w.scanTable('settings')).toEqual(before.settings);
    expect(await w.scanTable('audit_events')).toEqual(before.audit);
  }, 120_000);

  it('an apply REFUSES when a --skip id names no contact at all - after the Scan, before any history read or write: nothing written, nothing printed', async () => {
    const w = await newWorld();
    await seedLeads(w);
    // A pointer row is not a contact: its id names no contact either.
    await w.put({ contactId: 'phoneref#+15550001001', phone: '+15550001001', phone_ref: true, phone_ref_owner: 'c-old' });
    const before = {
      contacts: await w.scanTable('contacts'),
      settings: await w.scanTable('settings'),
      audit: await w.scanTable('audit_events'),
    };
    const recorder = recordingClient(doc);
    const { deps, printed } = w.deps({ onDoc: recorder.doc });
    const skip = new Set(['c-skip', 'c-typo', 'phoneref#+15550001001', 'c-nobody', 'c-flyer']);
    const outcome = await runJoinAuthorityBackfill(deps, { apply: true, skip }).then(
      () => 'ran',
      (err: unknown) => err,
    );
    expect(outcome).toBeInstanceOf(BackfillRefusedError);
    expect((outcome as Error).message).toBe(SKIP_REFUSAL('c-nobody, c-typo, phoneref#+15550001001'));
    expect(recorder.sent).toEqual(['GetCommand', 'ScanCommand']);
    expect(printed).toEqual([]);
    expect(await w.scanTable('contacts')).toEqual(before.contacts);
    expect(await w.scanTable('settings')).toEqual(before.settings);
    expect(await w.scanTable('audit_events')).toEqual(before.audit);
  }, 120_000);

  it('an apply goes ahead when every --skip id names an existing contact - a non-candidate one (a flyer lead, one holding an authority, one with the marker, a DELETED one) is reported and ignored', async () => {
    const w = await newWorld();
    await seedLeads(w);
    await w.lead('c-gone', { deleted_at: '2026-09-01T00:00:00.000Z' });
    const { deps, printed } = w.deps();
    const report = await runJoinAuthorityBackfill(deps, {
      apply: true,
      skip: new Set(['c-skip', 'c-marker', 'c-held', 'c-gone', 'c-flyer']),
    });
    expect(report).toMatchObject({
      unknownSkips: ['c-flyer', 'c-gone', 'c-held', 'c-marker'],
      missingSkips: [],
      written: 3,
      failed: 0,
    });
    expect(printed).toContain('--skip ids that are not candidates (ignored): c-flyer, c-gone, c-held, c-marker');
    expect(backfillExitCode(report)).toBe(0);
  }, 120_000);

  it('an apply goes ahead over a STALE running rewrite (no heartbeat for 15 minutes) - and never touches the lock', async () => {
    const stale = new Date(Date.now() - 16 * 60_000).toISOString();
    const killed: OrgRewriteState = { ...freshRewrite(), jobId: 'job-killed', heartbeatAt: stale, startedAt: stale };
    const w = await newWorld(listItem(startingEntries(), killed));
    await seedLeads(w);
    const report = await runJoinAuthorityBackfill(w.deps().deps, { apply: true, skip: SKIP });
    expect(report).toMatchObject({ written: 3, failed: 0 });
    expect((await w.orgList.peek())?.lastRewrite).toEqual(killed);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The CLI (spec D10: --env local|dev|prod, --lane with local only, dry run by
// default, --apply, --skip; exit 0 completed clean, 1 refused / a failed lead /
// the run stopped / the target unresolved, 2 usage). `main` is the CLI with
// its outside world injected, so every exit code is EXECUTED here; the last
// test runs the real entry point in a child process.
// ---------------------------------------------------------------------------

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'backfill-join-housing-authority.ts',
);

const CLEAN_REPORT: BackfillReport = {
  targets: [],
  leftOut: [],
  unknownSkips: [],
  missingSkips: [],
  written: 0,
  skipped: 0,
  failed: 0,
  warnings: [],
};

/** A stage whose client is never sent a command; destroy() is counted. */
function fakeStage(): { stage: StageClient; destroyed: () => number } {
  let destroyed = 0;
  const stage: StageClient = {
    doc: {
      destroy: () => {
        destroyed += 1;
      },
    } as unknown as DynamoDBDocumentClient,
    env: { TABLE_PREFIX: 'hc-local-4-' },
    endpoint: 'http://localhost:8000',
    prefix: 'hc-local-4-',
    accessKeyId: 'hclane4',
    describe: 'a fake stage',
  };
  return { stage, destroyed: () => destroyed };
}

describe('the CLI arguments', () => {
  it('dry run by default; --apply writes; --skip takes ONE comma-separated value; anything else is a usage error', () => {
    const dry = parseStageArgs(['--env', 'prod'], BACKFILL_ARGS);
    if ('usage' in dry) throw new Error('expected a parse');
    expect(dry.target).toBe('prod');
    expect(dry.flags.has('--apply')).toBe(false);
    expect(parseSkipList(dry.values.get('--skip'))).toEqual(new Set());
    const lane = parseStageArgs(['--env', 'local', '--lane', '4', '--apply', '--skip', 'contact-a,contact-b'], BACKFILL_ARGS);
    if ('usage' in lane) throw new Error('expected a parse');
    expect(lane).toMatchObject({ target: 'local', lane: 4 });
    expect(lane.flags.has('--apply')).toBe(true);
    expect(parseSkipList(lane.values.get('--skip'))).toEqual(new Set(['contact-a', 'contact-b']));
    for (const argv of [
      ['--env', 'dev', '--dry-run'],
      ['--env', 'dev', '--lane', '2'],
      ['--env', 'dev', '--apply', '--apply'],
      ['--env', 'dev', '--skip', 'contact-a', '--skip', 'contact-b'],
      ['--env', 'dev', '--skip'],
      ['--env', 'dev', '--skip', '--apply'],
      ['--apply'],
    ]) {
      expect(parseStageArgs(argv, BACKFILL_ARGS)).toEqual({ usage: true });
    }
  });

  it('parseSkipList trims each id; an empty id (an empty value, a stray comma) is a usage error', () => {
    expect(parseSkipList(undefined)).toEqual(new Set());
    expect(parseSkipList('contact-a')).toEqual(new Set(['contact-a']));
    expect(parseSkipList(' contact-a , contact-b ')).toEqual(new Set(['contact-a', 'contact-b']));
    for (const raw of ['', ' ', ',', 'contact-a,', 'contact-a,,contact-b']) {
      expect(parseSkipList(raw)).toBeUndefined();
    }
  });
});

describe('main - every exit code, executed (spec D10)', () => {
  it('exits 2 on a usage error and prints the usage text, before any target is resolved', async () => {
    const errors: string[] = [];
    let resolved = 0;
    const usageErrors = [
      [],
      ['--env', 'dev', '--dry-run'],
      ['--env', 'prod', '--lane', '3'],
      ['--env', 'dev', '--skip', ''],
      ['--env', 'dev', '--skip', 'contact-a,,contact-b'],
    ];
    for (const argv of usageErrors) {
      const exit = await main(argv, {
        printError: (text) => errors.push(text),
        resolveStage: async () => {
          resolved += 1;
          return fakeStage().stage;
        },
        logger: silent,
      });
      expect([argv, exit]).toEqual([argv, 2]);
    }
    expect(resolved).toBe(0);
    expect(errors).toEqual(usageErrors.map(() => USAGE));
  });

  it('hands --env, --lane, --apply and --skip on; exits 0 on a clean report (warnings included) and 1 on a failed lead; the client is destroyed each time', async () => {
    const resolveCalls: unknown[] = [];
    const runCalls: BackfillOptions[] = [];
    const cases: Array<[BackfillReport, 0 | 1]> = [
      [CLEAN_REPORT, 0],
      [{ ...CLEAN_REPORT, warnings: ['a warning'] }, 0],
      [{ ...CLEAN_REPORT, failed: 1 }, 1],
    ];
    for (const [report, code] of cases) {
      const fake = fakeStage();
      const stagesRun: StageClient[] = [];
      const exit = await main(['--env', 'local', '--lane', '4', '--apply', '--skip', ' contact-a , contact-b '], {
        resolveStage: async (target, opts) => {
          resolveCalls.push([target, opts]);
          return fake.stage;
        },
        run: async (stage, opts) => {
          stagesRun.push(stage);
          runCalls.push(opts);
          return report;
        },
        logger: silent,
      });
      expect(exit).toBe(code);
      expect(stagesRun).toEqual([fake.stage]);
      expect(fake.destroyed()).toBe(1);
    }
    expect(resolveCalls).toEqual(cases.map(() => ['local', { lane: 4 }]));
    expect(runCalls).toEqual(cases.map(() => ({ apply: true, skip: new Set(['contact-a', 'contact-b']) })));

    // No --apply, no --lane, no --skip: a dry run with nothing skipped and no lane option.
    const plain = fakeStage();
    const seen: unknown[] = [];
    const exit = await main(['--env', 'dev'], {
      resolveStage: async (target, opts) => {
        seen.push([target, opts]);
        return plain.stage;
      },
      run: async (_stage, opts) => {
        seen.push(opts);
        return CLEAN_REPORT;
      },
      logger: silent,
    });
    expect(exit).toBe(0);
    expect(seen).toEqual([['dev', {}], { apply: false, skip: new Set() }]);
    expect(plain.destroyed()).toBe(1);
  });

  it('exits 1 when the target cannot be resolved - nothing is run', async () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    let ran = 0;
    const exit = await main(['--env', 'prod'], {
      resolveStage: async () => {
        throw new Error('ACCOUNT GUARD: wrong account');
      },
      run: async () => {
        ran += 1;
        return CLEAN_REPORT;
      },
      logger: log,
    });
    expect(exit).toBe(1);
    expect(ran).toBe(0);
    expect(capture.atLevel(50).some((l) => String(l['msg']).includes('FAILED before the run started'))).toBe(true);
  });

  it('exits 1 on a refusal (its message printed) and on a run that stopped (logged FAILED) - the client destroyed either way', async () => {
    const errors: string[] = [];
    const refused = fakeStage();
    const refusedExit = await main(['--env', 'dev', '--apply'], {
      resolveStage: async () => refused.stage,
      run: async () => {
        throw new BackfillRefusedError('REFUSED - a test refusal');
      },
      printError: (text) => errors.push(text),
      logger: silent,
    });
    expect(refusedExit).toBe(1);
    expect(errors).toEqual(['REFUSED - a test refusal']);
    expect(refused.destroyed()).toBe(1);

    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    const stopped = fakeStage();
    const stoppedExit = await main(['--env', 'dev'], {
      resolveStage: async () => stopped.stage,
      run: async () => {
        throw new Error('contacts table unavailable');
      },
      printError: (text) => errors.push(text),
      logger: log,
    });
    expect(stoppedExit).toBe(1);
    expect(capture.atLevel(50).some((l) => l['msg'] === 'backfill-join-housing-authority - FAILED: contacts table unavailable')).toBe(
      true,
    );
    expect(errors).toEqual(['REFUSED - a test refusal']);
    expect(stopped.destroyed()).toBe(1);
  });
});

describe.skipIf(!reachable)('main against DynamoDB Local - the real run behind the CLI', () => {
  afterEach(dropCreatedTables, 120_000);

  /** The world's own tables on the shared client (the recorder's destroy() is a no-op, so the shared client survives). */
  const stageOf = (w: World): StageClient => ({
    doc: recordingClient(doc).doc,
    env: w.env,
    endpoint,
    prefix: String(w.env['TABLE_PREFIX']),
    accessKeyId: undefined,
    describe: 'a test world',
  });
  const realRun =
    (printed: string[]) =>
    (stage: StageClient, opts: BackfillOptions): Promise<BackfillReport> =>
      runJoinAuthorityBackfill(buildBackfillDeps(stage, { logger: silent, print: (line) => printed.push(line) }), opts);

  it('a dry run of the seeded world exits 0 and prints the report - nothing written', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const printed: string[] = [];
    const exit = await main(['--env', 'local', '--lane', '7', '--skip', 'c-skip'], {
      resolveStage: async () => stageOf(w),
      run: realRun(printed),
      logger: silent,
    });
    expect(exit).toBe(0);
    expect(printed[0]).toBe(
      'DRY RUN - nothing written. Leads that WOULD get "Atlanta Housing Authority" (oldest sign-up first; dates are UTC):',
    );
    expect(printed).toContain('Would update: 3 lead(s). Failed: 0.');
    expect(await w.backfillEvents()).toEqual([]);
  }, 120_000);

  it('a --skip id that names no contact: the dry run exits 0 and reports it; the apply exits 1 with the refusal printed - nothing written', async () => {
    const w = await newWorld();
    await seedLeads(w);
    const before = { contacts: await w.scanTable('contacts'), audit: await w.scanTable('audit_events') };
    const dryPrinted: string[] = [];
    const dryExit = await main(['--env', 'local', '--lane', '7', '--skip', 'c-skip,c-nobody'], {
      resolveStage: async () => stageOf(w),
      run: realRun(dryPrinted),
      logger: silent,
    });
    expect(dryExit).toBe(0);
    expect(dryPrinted).toContain('--skip id that names no contact (a typo?) - an --apply refuses to run with it: c-nobody');
    const errors: string[] = [];
    const printed: string[] = [];
    const exit = await main(['--env', 'local', '--lane', '7', '--apply', '--skip', 'c-skip,c-nobody'], {
      resolveStage: async () => stageOf(w),
      run: realRun(printed),
      printError: (text) => errors.push(text),
      logger: silent,
    });
    expect(exit).toBe(1);
    expect(errors).toEqual([SKIP_REFUSAL('c-nobody')]);
    expect(printed).toEqual([]);
    expect(await w.scanTable('contacts')).toEqual(before.contacts);
    expect(await w.scanTable('audit_events')).toEqual(before.audit);
  }, 120_000);

  it('an apply on an environment with no organization list exits 1 with the refusal printed - nothing read, nothing written', async () => {
    const w = await newWorld(null);
    await seedLeads(w);
    const before = await w.scanTable('contacts');
    const errors: string[] = [];
    const printed: string[] = [];
    const exit = await main(['--env', 'local', '--lane', '7', '--apply'], {
      resolveStage: async () => stageOf(w),
      run: realRun(printed),
      printError: (text) => errors.push(text),
      logger: silent,
    });
    expect(exit).toBe(1);
    expect(errors).toEqual([NO_LIST_REFUSAL]);
    expect(printed).toEqual([]);
    expect(await w.scanTable('contacts')).toEqual(before);
  }, 120_000);
});

describe('the entry point, in a child process', () => {
  it('a usage error exits 2 with the usage text - no client is ever built', () => {
    // `node --import tsx <script>`: the app/test/otel.test.ts precedent (a
    // .bin/tsx.cmd shim is EINVAL under spawnSync on Windows). The arguments
    // fail to parse before any target is resolved: no database, no network.
    // They name NO --env at all (a usage error by itself), so even a parser
    // that tolerated the unknown flag could never reach a deployed target.
    const child = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT_PATH, '--bogus'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    const seen = JSON.stringify({ status: child.status, signal: child.signal, error: child.error?.message, stderr: child.stderr });
    expect(child.status, seen).toBe(2);
    expect(child.stderr, seen).toContain('Usage: npx tsx app/scripts/backfill-join-housing-authority.ts --env local|dev|prod');
  }, 90_000);
});
