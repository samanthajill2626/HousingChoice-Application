// Cross-stack consent-copy DRIFT GUARD (spec §9).
//
// dashboard/src/lib/consentCopy.ts HAND-MIRRORS the app's A2P consent constants
// (the dashboard is a separate package and cannot import from app/). Each side
// already pins its own copy verbatim; the gap this closes is that NOTHING asserts
// the two sides MATCH. This test compares the RESOLVED string values across the
// two source trees so any drift breaks loudly.
//
// WHY THIS LIVES IN THE app WORKSPACE (not e2e or a scripts/*.mjs comparator):
// app's TEST tsconfig (app/tsconfig.test.json) has NO `rootDir` clamp and already
// reaches OUTSIDE the package (it includes ../e2e/support and ../fake-twilio/src)
// — the rootDir:"src" clamp the worklist cited applies only to the BUILD
// tsconfig, not this one — so a direct cross-package import of dashboard source
// typechecks cleanly here. Unlike the Playwright/tsx loader (which a2p-
// compliance.spec.ts deliberately avoids by hand-mirroring the app consts), this
// import resolves under vitest AND runs in the standard `npm run test -w app`
// suite, so the guard executes on every app test run with zero extra wiring.
import { describe, expect, it } from 'vitest';
import {
  SMS_BRAND_NAME,
  WEB_FORM_CONSENT_COPY,
  CONSENT_VERSION as APP_CONSENT_VERSION,
  PRIVACY_POLICY_URL as APP_PRIVACY_POLICY_URL,
  TERMS_URL as APP_TERMS_URL,
  HUMAN_CONSENT_METHODS as APP_HUMAN_CONSENT_METHODS,
} from '../src/lib/smsCompliance.js';
import {
  SMS_BRAND,
  WEB_FORM_CONSENT_LABEL,
  CONSENT_VERSION as DASH_CONSENT_VERSION,
  PRIVACY_POLICY_URL as DASH_PRIVACY_POLICY_URL,
  TERMS_URL as DASH_TERMS_URL,
  HUMAN_CONSENT_METHODS as DASH_HUMAN_CONSENT_METHODS,
} from '../../dashboard/src/lib/consentCopy.js';

describe('consent copy — app ↔ dashboard drift guard (spec §9)', () => {
  it('brand name matches (SMS_BRAND_NAME === SMS_BRAND)', () => {
    expect(SMS_BRAND).toBe(SMS_BRAND_NAME);
  });

  it('web-form consent disclosure matches (resolved string equality)', () => {
    // app interpolates ${SMS_BRAND_NAME}; dashboard hardcodes the brand + is
    // `+`-concatenated — compare the FINAL rendered strings.
    expect(WEB_FORM_CONSENT_LABEL).toBe(WEB_FORM_CONSENT_COPY);
  });

  it('consent version matches', () => {
    expect(DASH_CONSENT_VERSION).toBe(APP_CONSENT_VERSION);
  });

  it('policy links match', () => {
    expect(DASH_PRIVACY_POLICY_URL).toBe(APP_PRIVACY_POLICY_URL);
    expect(DASH_TERMS_URL).toBe(APP_TERMS_URL);
  });

  it('human consent methods match (SAME values, SAME order — Set vs array shape)', () => {
    // app is a ReadonlySet, dashboard a readonly array — compare as arrays.
    expect([...DASH_HUMAN_CONSENT_METHODS]).toEqual([...APP_HUMAN_CONSENT_METHODS]);
  });
});
