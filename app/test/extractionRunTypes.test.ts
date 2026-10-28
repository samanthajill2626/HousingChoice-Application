// The run vocabulary is a CONTRACT: sixteen targets in a fixed order, and a
// drop-reason set re-enumerated against every discard branch in apply.ts
// (design 7.2, as amended; B1 spec D3 adds the four tenant matching inputs and
// text_field_filled). A change here changes what the run log can say.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DECISION_TARGETS, DROP_REASONS } from '../src/services/extraction/runTypes.js';

// path.dirname(fileURLToPath(...)), never new URL(...).pathname (a leading
// slash on win32) - the idiom every source-reading test here uses.
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('runTypes - the decision vocabulary', () => {
  it('carries exactly the sixteen decision targets, in the documented order', () => {
    expect(DECISION_TARGETS).toEqual([
      'firstName', 'lastName', 'voucherSize', 'housingAuthority',
      'pets', 'evictions', 'tenure', 'porting',
      'area_preference', 'max_tenant_portion', 'accessibility_need', 'preferences_constraints',
      'address', 'status', 'type', 'phone',
    ]);
  });

  it('carries exactly the fourteen drop reasons a run can record', () => {
    expect([...DROP_REASONS].sort()).toEqual([
      'agency_not_authority',
      'dismissed_before',
      'empty_value_at_parse',
      'equal_to_current',
      'invalid_value',
      'phone_already_owned',
      'phone_not_canonicalizable',
      'phone_owned_by_other',
      'repo_error',
      'status_not_onboarding_tenant',
      'text_field_filled',
      'type_already_classified',
      'type_classification_changed',
      'wrong_contact_type',
    ]);
  });

  it('stays cycle-free: imports ONLY the tenant matching inputs leaf, which imports nothing (B1 WI13)', () => {
    const runTypes = readFileSync(path.join(SRC, 'services', 'extraction', 'runTypes.ts'), 'utf8');
    const specifiers = [...runTypes.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['../../lib/tenantMatchingInputs.js']);
    const list = readFileSync(path.join(SRC, 'lib', 'tenantMatchingInputs.ts'), 'utf8');
    expect(list).not.toMatch(/^\s*import\s/m);
  });
});
