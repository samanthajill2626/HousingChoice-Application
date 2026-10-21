// publicApi - the /join housing authority additions (join-housing-authority
// spec D1, D3, D8): submitHousingFair sends housingAuthority only when it is
// defined, and getHousingAuthorities reads GET /public/housing-authorities.
// The transport (request) is mocked; ApiError stays the real class.
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('../../api/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/client.js')>('../../api/client.js');
  return { ...actual, request: (...a: unknown[]) => request(...a) };
});

import { ApiError } from '../../api/client.js';
import {
  HOUSING_AUTHORITY_NOT_LISTED,
  getHousingAuthorities,
  submitHousingFair,
  type PublicAddress,
  type PublicFlyer,
} from './publicApi.js';

const PERSON = {
  firstName: 'Grace',
  lastName: 'Hopper',
  phone: '+14045559999',
  smsConsent: true,
};

/** The JSON body `request` was called with on call N. */
function bodyOf(call: number): Record<string, unknown> {
  return (request.mock.calls[call]?.[1] as { body: Record<string, unknown> }).body;
}

beforeEach(() => {
  request.mockReset();
});

describe('submitHousingFair', () => {
  it('sends housingAuthority when it is defined', async () => {
    request.mockResolvedValue({ ok: true });
    await submitHousingFair({ ...PERSON, housingAuthority: 'Atlanta Housing Authority' });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe('/public/housing-fair');
    expect(request.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(bodyOf(0)).toEqual({ ...PERSON, housingAuthority: 'Atlanta Housing Authority' });
  });

  it('omits housingAuthority when it is undefined ("Not sure", and every flyer sign-up)', async () => {
    request.mockResolvedValue({ ok: true });
    await submitHousingFair({ ...PERSON, unitId: 'unit-1' });

    expect(bodyOf(0)).toEqual({ ...PERSON, unitId: 'unit-1' });
    expect(Object.keys(bodyOf(0))).not.toContain('housingAuthority');
  });

  it('(PIN) omits voucherSize and unitId when absent and sends them when present', async () => {
    request.mockResolvedValue({ ok: true });
    await submitHousingFair({ ...PERSON });
    await submitHousingFair({ ...PERSON, voucherSize: 2, unitId: 'unit-9' });

    expect(Object.keys(bodyOf(0)).sort()).toEqual(['firstName', 'lastName', 'phone', 'smsConsent']);
    expect(bodyOf(1)).toEqual({ ...PERSON, voucherSize: 2, unitId: 'unit-9' });
  });
});

describe('getHousingAuthorities', () => {
  it('GETs /public/housing-authorities with the caller signal and returns the names', async () => {
    request.mockResolvedValue({ names: ['Atlanta Housing Authority', 'DeKalb Housing Authority'] });
    const controller = new AbortController();

    await expect(getHousingAuthorities(controller.signal)).resolves.toEqual([
      'Atlanta Housing Authority',
      'DeKalb Housing Authority',
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe('/public/housing-authorities');
    const options = request.mock.calls[0]![1] as { method?: string; signal?: AbortSignal; body?: unknown };
    expect(options.signal).toBe(controller.signal);
    expect(options.method === undefined || options.method === 'GET').toBe(true);
    expect(options.body).toBeUndefined();
  });

  it('passes a failed read through as the ApiError (a 429 included)', async () => {
    const tooMany = new ApiError(429, 'rate_limited', 'rate_limited', { error: 'rate_limited' });
    request.mockRejectedValue(tooMany);

    await expect(getHousingAuthorities()).rejects.toBe(tooMany);
  });

  it('throws ApiError invalid_response for a body that is not { names: string[] }', async () => {
    for (const body of [undefined, {}, { names: 'Atlanta Housing Authority' }, { names: [1, 2] }]) {
      request.mockReset();
      request.mockResolvedValue(body);
      const failure = getHousingAuthorities();
      await expect(failure).rejects.toBeInstanceOf(ApiError);
      await expect(failure).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
});

describe('HOUSING_AUTHORITY_NOT_LISTED', () => {
  it("is the sign-up's refusal code for an unlisted authority (spec D3)", () => {
    expect(HOUSING_AUTHORITY_NOT_LISTED).toBe('housing_authority_not_listed');
  });
});

// flyer-leads D1: the public projection no longer carries rent, lease terms,
// accessibility, pets or deposit - the keys are REMOVED, never null - so the
// client type drops the same ten. A TYPE pin: vitest strips types, so these
// cases pass at runtime either way; `npm run typecheck` is what fails while
// any of the keys is still on PublicFlyer.
type TrimmedFlyerKey =
  | 'rent_min'
  | 'rent_max'
  | 'lease_terms'
  | 'accessibility'
  | 'pets'
  | 'no_pets'
  | 'pet_fee'
  | 'deposit'
  | 'deposit_one_month'
  | 'deposit_flexible';

describe('PublicFlyer (flyer-leads D1)', () => {
  it('carries none of the ten trimmed keys', () => {
    expectTypeOf<Extract<keyof PublicFlyer, TrimmedFlyerKey>>().toBeNever();
  });

  it('(PIN) keeps the application fee and the address', () => {
    expectTypeOf<PublicFlyer['application_fee']>().toEqualTypeOf<number | null>();
    expectTypeOf<PublicFlyer['address']>().toEqualTypeOf<PublicAddress>();
  });
});
