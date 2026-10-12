// The /join housing authority backfill (spec
// docs/superpowers/specs/2026-10-12-join-housing-authority-design.md, D10
// and D11). The PURE rules first: who is a candidate, and which audit history
// leaves one out - each writer's payload exactly as it appends it today.
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../src/repos/auditRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  BACKFILL_AUDIT_TYPE,
  BACKFILL_AUTHORITY,
  isCandidate,
  leftOutReasonFromAudit,
  touchesHousingAuthority,
} from '../scripts/backfill-join-housing-authority.js';

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
  it('writes Atlanta Housing Authority under its own audit event type', () => {
    expect(BACKFILL_AUTHORITY).toBe('Atlanta Housing Authority');
    expect(BACKFILL_AUDIT_TYPE).toBe('housing_authority_backfill');
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
