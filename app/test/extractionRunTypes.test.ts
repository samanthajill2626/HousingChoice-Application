// The run vocabulary is a CONTRACT: twelve targets in a fixed order, and a
// drop-reason set re-enumerated against every discard branch in apply.ts
// (design 7.2, as amended). A change here changes what the run log can say.
import { describe, expect, it } from 'vitest';
import { DECISION_TARGETS, DROP_REASONS } from '../src/services/extraction/runTypes.js';

describe('runTypes - the decision vocabulary', () => {
  it('carries exactly the twelve decision targets, in the documented order', () => {
    expect(DECISION_TARGETS).toEqual([
      'firstName', 'lastName', 'voucherSize', 'housingAuthority',
      'pets', 'evictions', 'tenure', 'porting',
      'address', 'status', 'type', 'phone',
    ]);
  });

  it('carries exactly the twelve drop reasons a run can record', () => {
    expect([...DROP_REASONS].sort()).toEqual([
      'dismissed_before',
      'empty_value_at_parse',
      'equal_to_current',
      'invalid_value',
      'phone_already_owned',
      'phone_not_canonicalizable',
      'phone_owned_by_other',
      'repo_error',
      'status_not_onboarding_tenant',
      'type_already_classified',
      'type_classification_changed',
      'wrong_contact_type',
    ]);
  });
});
