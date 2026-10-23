// Cross-workspace contact-status MIRROR DRIFT GUARD (spec 2026-10-23 D1, D3;
// plan ruling AR2).
//
// api/types.ts HAND-COPIES the per-type contact status lists and labels from
// app/src/lib/statusModel.ts (the dashboard is a separate package and cannot
// import app code at runtime). The contact page header dropdown and the Edit
// contact details Status field both read the dashboard copy, so a status the
// server accepts that the dashboard does not offer - or one the dashboard
// offers that the server refuses - is exactly the drift D3 exists to remove.
//
// MECHANISM: the caseworkerRoleMirror.test.ts one - import both copies and
// compare. The app module is a LEAF with no imports at all (plan ruling AR1
// keeps it that way), so the dashboard typecheck compiles one app file and
// never the repos, adapters or lib/config.ts. Import nothing else from app/
// here.
import { describe, expect, it } from 'vitest';
import {
  LANDLORD_STATUSES as APP_LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS as APP_LANDLORD_STATUS_LABELS,
  PARTNER_STATUSES as APP_PARTNER_STATUSES,
  PARTNER_STATUS_LABELS as APP_PARTNER_STATUS_LABELS,
  TENANT_STATUSES as APP_TENANT_STATUSES,
  TENANT_STATUS_LABELS as APP_TENANT_STATUS_LABELS,
  UNKNOWN_STATUSES as APP_UNKNOWN_STATUSES,
  UNKNOWN_STATUS_LABELS as APP_UNKNOWN_STATUS_LABELS,
  statusAllowlistFor,
  statusLabelFor,
} from '../../../../app/src/lib/statusModel.js';
import {
  LANDLORD_STATUSES,
  LANDLORD_STATUS_LABELS,
  PARTNER_STATUSES,
  PARTNER_STATUS_LABELS,
  TENANT_STATUSES,
  TENANT_STATUS_LABELS,
  UNKNOWN_STATUSES,
  UNKNOWN_STATUS_LABELS,
  contactStatusLabelFor,
  statusOptionsFor,
} from '../../api/types.js';

/** Every contact type, plus the unset type both sides must treat alike. */
const TYPES = ['tenant', 'landlord', 'partner', 'team_member', 'unknown', undefined] as const;

describe('dashboard contact status lists mirror app/src/lib/statusModel.ts', () => {
  it('each list constant is identical, in order', () => {
    expect([...TENANT_STATUSES]).toEqual([...APP_TENANT_STATUSES]);
    expect([...LANDLORD_STATUSES]).toEqual([...APP_LANDLORD_STATUSES]);
    expect([...PARTNER_STATUSES]).toEqual([...APP_PARTNER_STATUSES]);
    expect([...UNKNOWN_STATUSES]).toEqual([...APP_UNKNOWN_STATUSES]);
  });

  it('each label map is identical', () => {
    expect(TENANT_STATUS_LABELS).toEqual(APP_TENANT_STATUS_LABELS);
    expect(LANDLORD_STATUS_LABELS).toEqual(APP_LANDLORD_STATUS_LABELS);
    expect(PARTNER_STATUS_LABELS).toEqual(APP_PARTNER_STATUS_LABELS);
    expect(UNKNOWN_STATUS_LABELS).toEqual(APP_UNKNOWN_STATUS_LABELS);
  });

  it.each(TYPES.map((type) => [type]))('statusOptionsFor(%s) offers exactly the server allowlist, in order', (type) => {
    expect(statusOptionsFor(type).map((o) => o.value)).toEqual([...statusAllowlistFor(type)]);
  });

  it.each(TYPES.map((type) => [type]))('every %s option carries the server label', (type) => {
    for (const { value, label } of statusOptionsFor(type)) {
      expect(label).toBe(statusLabelFor(type, value));
      expect(contactStatusLabelFor(type, value)).toBe(statusLabelFor(type, value));
    }
  });

  it('does not compare empty lists (the D1 floor)', () => {
    expect(statusOptionsFor('unknown').map((o) => o.value)).toEqual(['needs_review', 'inactive']);
    expect(statusOptionsFor('partner').map((o) => o.value)).toEqual(['needs_review', 'active', 'inactive']);
  });
});
