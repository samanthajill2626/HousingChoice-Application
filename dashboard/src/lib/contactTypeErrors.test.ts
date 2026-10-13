// contactTypeErrorMessage - the dashboard copy for the contact-type refusals
// (caseworker integrity spec 2026-10-12, section 4; plan section 1 copy
// table). Every sentence is pinned verbatim; anything that is not one of the
// five codes answers null so each call site keeps its own fallback (W7).
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.js';
import { contactTypeErrorMessage } from './contactTypeErrors.js';

function refusal(status: number, code: string, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError(status, code, code, { error: code, ...extra });
}

describe('contactTypeErrorMessage', () => {
  it.each([
    ['tenant', 'Tours and placements are for tenants. This contact is a tenant.'],
    ['landlord', 'Tours and placements are for tenants. This contact is a landlord.'],
    ['partner', 'Tours and placements are for tenants. This contact is a partner.'],
    ['caseworker', 'Tours and placements are for tenants. This contact is a caseworker.'],
    ['team_member', 'Tours and placements are for tenants. This contact is a team member.'],
    ['unknown', 'Tours and placements are for tenants. This contact is not classified yet.'],
  ])('contact_not_tenant with contactKind %s', (kind, sentence) => {
    expect(contactTypeErrorMessage(refusal(409, 'contact_not_tenant', { contactKind: kind }))).toBe(sentence);
  });

  it('contact_not_tenant with a missing or unrecognized contactKind still reads as a sentence', () => {
    const other = 'Tours and placements are for tenants. This contact is not a tenant.';
    expect(contactTypeErrorMessage(refusal(409, 'contact_not_tenant'))).toBe(other);
    expect(contactTypeErrorMessage(refusal(409, 'contact_not_tenant', { contactKind: 'robot' }))).toBe(other);
    expect(contactTypeErrorMessage(refusal(409, 'contact_not_tenant', { contactKind: 'toString' }))).toBe(other);
    expect(contactTypeErrorMessage(refusal(409, 'contact_not_tenant', { contactKind: 7 }))).toBe(other);
    expect(contactTypeErrorMessage(new ApiError(409, 'contact_not_tenant', 'contact_not_tenant'))).toBe(other);
  });

  it.each([
    ['tenant_not_found', 404, 'That contact no longer exists.'],
    ['landlord_not_landlord', 409, "Only a landlord can be a property's landlord of record."],
    ['landlord_not_found', 404, 'That landlord no longer exists.'],
    ['contact_list_caseworker', 409, "Caseworkers can't be on a property's contact list."],
  ])('%s', (code, status, sentence) => {
    expect(contactTypeErrorMessage(refusal(status, code))).toBe(sentence);
  });

  it.each([
    ['another 409 code (tour_changed)', refusal(409, 'tour_changed')],
    ['another 409 code (illegal_status_transition)', refusal(409, 'illegal_status_transition')],
    ['another 404 code (tour_not_found)', refusal(404, 'tour_not_found')],
    ['a 500', new ApiError(500, 'internal_error', 'internal_error')],
    ['a network failure', new ApiError(0, 'network_error', 'Network error')],
    ['a plain Error', new Error('contact_not_tenant')],
    ['a string', 'contact_not_tenant'],
    ['undefined', undefined],
  ])('returns null for %s (the site keeps its fallback)', (_label, err) => {
    expect(contactTypeErrorMessage(err)).toBeNull();
  });
});
