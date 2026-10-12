// contactTypeGuards (caseworker integrity spec 2026-10-12, sections 1 and 4):
// the CONSISTENT tenant / landlord reads behind I2 and I3, and the one mapping
// from their four errors to HTTP answers. Pure: a stub contacts repo and a
// recording response - no harness, no DynamoDB.
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  ContactNotTenantError,
  LandlordNotFoundError,
  LandlordNotLandlordError,
  requireLandlordContact,
  requireTenantContact,
  sendContactTypeError,
  TenantNotFoundError,
} from '../src/services/contactTypeGuards.js';

/** A contacts repo that answers `contact` for any id and records each call. */
function repoAnswering(contact: ContactItem | undefined) {
  return {
    getById: vi.fn(async (_contactId: string, _opts?: { consistentRead?: boolean }) => contact),
  };
}

interface FakeResponse {
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
}

/** A response that records the status and JSON body it was given. */
function recordingResponse(): { res: Response; sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {};
  const res: FakeResponse = {
    status(code) {
      sent.status = code;
      return res;
    },
    json(body) {
      sent.body = body;
      return res;
    },
  };
  return { res: res as unknown as Response, sent };
}

describe('requireTenantContact (I2)', () => {
  it('reads the contact CONSISTENTLY and returns a contact typed tenant', async () => {
    const tenant: ContactItem = { contactId: 'c-1', type: 'tenant' };
    const repo = repoAnswering(tenant);
    await expect(requireTenantContact(repo, 'c-1')).resolves.toBe(tenant);
    expect(repo.getById).toHaveBeenCalledTimes(1);
    expect(repo.getById).toHaveBeenCalledWith('c-1', { consistentRead: true });
  });

  it('a soft-deleted tenant still exists (no deleted-contact refusal, spec section 10)', async () => {
    const deleted: ContactItem = { contactId: 'c-1', type: 'tenant', deleted_at: '2026-10-01T00:00:00.000Z' };
    await expect(requireTenantContact(repoAnswering(deleted), 'c-1')).resolves.toBe(deleted);
  });

  it('throws TenantNotFoundError when the contact does not exist', async () => {
    await expect(requireTenantContact(repoAnswering(undefined), 'c-gone')).rejects.toBeInstanceOf(
      TenantNotFoundError,
    );
  });

  it.each([
    ['landlord', { type: 'landlord' }, 'landlord'],
    ['landlord whose role says Caseworker (still a landlord)', { type: 'landlord', role: 'Caseworker' }, 'landlord'],
    ['partner', { type: 'partner' }, 'partner'],
    ['team member', { type: 'team_member' }, 'team_member'],
    ['unknown contact (unknown is NOT a tenant)', { type: 'unknown' }, 'unknown'],
    ['caseworker (partner + Caseworker role)', { type: 'partner', role: 'Caseworker' }, 'caseworker'],
    ['caseworker (role written case worker)', { type: 'partner', role: 'case worker' }, 'caseworker'],
  ] as const)('throws ContactNotTenantError for a %s, carrying contactKind', async (_label, fields, kind) => {
    const contact = { contactId: 'c-1', ...fields } as ContactItem;
    const err = await requireTenantContact(repoAnswering(contact), 'c-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContactNotTenantError);
    expect((err as ContactNotTenantError).contactKind).toBe(kind);
  });
});

describe('requireLandlordContact (I3)', () => {
  it('reads the contact CONSISTENTLY and returns a contact typed landlord', async () => {
    const landlord: ContactItem = { contactId: 'l-1', type: 'landlord' };
    const repo = repoAnswering(landlord);
    await expect(requireLandlordContact(repo, 'l-1')).resolves.toBe(landlord);
    expect(repo.getById).toHaveBeenCalledWith('l-1', { consistentRead: true });
  });

  it('a property manager is a landlord with a role, so it passes', async () => {
    const pm = { contactId: 'l-1', type: 'landlord', role: 'Property Manager' } as ContactItem;
    await expect(requireLandlordContact(repoAnswering(pm), 'l-1')).resolves.toBe(pm);
  });

  it('throws LandlordNotFoundError when the contact does not exist', async () => {
    await expect(requireLandlordContact(repoAnswering(undefined), 'l-gone')).rejects.toBeInstanceOf(
      LandlordNotFoundError,
    );
  });

  it.each([
    ['tenant', { type: 'tenant' }],
    ['partner', { type: 'partner' }],
    ['team member', { type: 'team_member' }],
    ['unknown contact', { type: 'unknown' }],
    ['caseworker', { type: 'partner', role: 'Caseworker' }],
  ] as const)('throws LandlordNotLandlordError for a %s', async (_label, fields) => {
    const contact = { contactId: 'l-1', ...fields } as ContactItem;
    await expect(requireLandlordContact(repoAnswering(contact), 'l-1')).rejects.toBeInstanceOf(
      LandlordNotLandlordError,
    );
  });
});

describe('sendContactTypeError', () => {
  it.each([
    ['TenantNotFoundError', () => new TenantNotFoundError(), 404, { error: 'tenant_not_found' }],
    [
      'ContactNotTenantError',
      () => new ContactNotTenantError('caseworker'),
      409,
      { error: 'contact_not_tenant', contactKind: 'caseworker' },
    ],
    ['LandlordNotFoundError', () => new LandlordNotFoundError(), 404, { error: 'landlord_not_found' }],
    ['LandlordNotLandlordError', () => new LandlordNotLandlordError(), 409, { error: 'landlord_not_landlord' }],
  ] as const)('answers %s and reports it handled', (_label, make, status, body) => {
    const { res, sent } = recordingResponse();
    expect(sendContactTypeError(make(), res)).toBe(true);
    expect(sent).toEqual({ status, body });
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a string', 'contact_not_tenant'],
    ['undefined', undefined],
  ])('returns false for %s and writes nothing', (_label, err) => {
    const { res, sent } = recordingResponse();
    expect(sendContactTypeError(err, res)).toBe(false);
    expect(sent).toEqual({});
  });

  it('the errors carry no ids or names - their messages are the codes', () => {
    expect(new TenantNotFoundError().message).toBe('tenant_not_found');
    expect(new ContactNotTenantError('landlord').message).toBe('contact_not_tenant');
    expect(new LandlordNotFoundError().message).toBe('landlord_not_found');
    expect(new LandlordNotLandlordError().message).toBe('landlord_not_landlord');
  });
});
