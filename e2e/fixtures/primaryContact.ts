// e2e/fixtures/primaryContact.ts
//
// The dev-only seam for primary-contact-integrity (spec
// docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md,
// section 10): POST /__dev/fixtures/zero-primary-property creates a NEW
// property in the imported shape - no landlord of record, the given contacts
// on its contact list as NON-primary rows, in the order given. The UI can
// reach a property with no primary contact (Restore without a landlord, then
// add only contacts not typed landlord), and can even recreate the imported
// shape - an eligible contact left non-primary - by classifying one of those
// contacts as a property manager after seating it (a type change promotes
// nobody, spec 4.4). The dev seam exists so a spec builds that shape in one
// call without the detour: a new property requires a landlord, and an add on
// an ownerless property makes an eligible contact primary at once. The
// byte-stable lean seed has none on purpose. Create the contacts first
// through POST /api/contacts; the seam writes only the property and never
// touches an existing one. Relative path: the lane's Vite server proxies
// /__dev to the app (reseed.ts, orgFixture.ts).
import type { APIRequestContext } from '@playwright/test';

/** A contact-list row the seam writes. `landlord` is refused: on a property
 *  with no landlord of record, a landlord-role add CLAIMS the slot. */
export interface ZeroPrimaryRow {
  contactId: string;
  role: 'pm' | 'owner' | 'other';
}

/** Create the property; returns its unitId. Throws on anything but 201. */
export async function createZeroPrimaryProperty(
  request: APIRequestContext,
  input: { street: string; rows: ZeroPrimaryRow[] },
): Promise<string> {
  const res = await request.post('/__dev/fixtures/zero-primary-property', { data: input });
  if (res.status() !== 201) {
    throw new Error(`/__dev/fixtures/zero-primary-property failed: ${res.status()} ${await res.text()}`);
  }
  return ((await res.json()) as { unitId: string }).unitId;
}
