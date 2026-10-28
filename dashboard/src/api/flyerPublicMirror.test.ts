// Cross-workspace FLYER_PUBLIC / SHAREABLE MIRROR DRIFT GUARD
// (permanent-flyer-links D1, D7; plan T4).
//
// api/types.ts HAND-COPIES both property-status sets from
// app/src/lib/statusModel.ts (the dashboard is a separate package and cannot
// import app code at runtime). The property page's flyer line (D7) gates on
// the dashboard FLYER_PUBLIC copy, so a status whose flyer the server serves
// but the dashboard calls off - or one the dashboard offers "View flyer" for
// that the server 404s - is exactly the drift this guard exists to catch.
//
// MECHANISM: the contactStatusMirror.test.ts one - import both copies and
// compare. The app module is a LEAF with no imports at all, so the dashboard
// typecheck compiles one app file and never the repos, adapters or
// lib/config.ts. Import nothing else from app/ here.
import { describe, expect, it } from 'vitest';
import {
  FLYER_PUBLIC as APP_FLYER_PUBLIC,
  SHAREABLE as APP_SHAREABLE,
} from '../../../app/src/lib/statusModel.js';
import { FLYER_PUBLIC, SHAREABLE } from './index.js';

describe('dashboard FLYER_PUBLIC and SHAREABLE mirror app/src/lib/statusModel.ts', () => {
  it('FLYER_PUBLIC holds exactly the statuses of the app set', () => {
    expect([...FLYER_PUBLIC].sort()).toEqual([...APP_FLYER_PUBLIC].sort());
  });

  it('FLYER_PUBLIC is the six public statuses - every listing status but setup', () => {
    expect([...FLYER_PUBLIC].sort()).toEqual([
      'available',
      'finalizing',
      'occupied',
      'off_market',
      'on_hold',
      'under_application',
    ]);
    expect(FLYER_PUBLIC.has('setup')).toBe(false);
  });

  it('SHAREABLE (the only status a property can be sent in) holds exactly the app set', () => {
    expect([...SHAREABLE].sort()).toEqual([...APP_SHAREABLE].sort());
  });
});
