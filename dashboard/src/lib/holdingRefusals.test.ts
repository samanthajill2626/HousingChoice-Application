// The shared holding-refusal copy (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3,
// D2): the conversion's four sentences keyed by KIND (byte-identical to what
// CaseworkerDialog showed), the generic type change's own landlord sentence,
// and the reader for a 409 type_change_refused body.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/index.js';
import { refusalCopy } from '../routes/contact/CaseworkerDialog.js';
import {
  TYPE_CHANGE_LANDLORD_SENTENCE,
  refusalCopyByKind,
  typeChangeRefusalCopy,
  typeChangeRefusalsFrom,
} from './holdingRefusals.js';

const PLACEMENT = {
  sentence: "Finish or close this contact's placement first.",
  linkText: 'View placement',
  to: '/placements/p%207',
};
const TOUR = {
  sentence: "Cancel or close this contact's open tour first.",
  linkText: 'View tour',
  to: '/tours/t1',
};
const CONVERSION_LANDLORD = {
  sentence: "This contact is the landlord of record for a property. Change that property's landlord first.",
  linkText: 'View property',
  to: '/listings/u1',
};
const ROSTER = {
  sentence: "This contact is on a property's contact list. Remove them from it first.",
  linkText: 'View property',
  to: '/listings/u2',
};

describe('refusalCopyByKind - the conversion wording, keyed by kind', () => {
  it('names each kind with its link, ids URL-encoded', () => {
    expect(refusalCopyByKind({ code: 'open_placement', placementId: 'p 7' })).toEqual(PLACEMENT);
    expect(refusalCopyByKind({ code: 'open_tour', tourId: 't1' })).toEqual(TOUR);
    expect(refusalCopyByKind({ code: 'landlord_of_record', unitId: 'u1' })).toEqual(CONVERSION_LANDLORD);
    expect(refusalCopyByKind({ code: 'on_roster', unitId: 'u2' })).toEqual(ROSTER);
  });

  it("CaseworkerDialog's refusalCopy answers exactly as before for its four codes (W2)", () => {
    expect(refusalCopy({ code: 'caseworker_open_placement', placementId: 'p 7' })).toEqual(PLACEMENT);
    expect(refusalCopy({ code: 'caseworker_open_tour', tourId: 't1' })).toEqual(TOUR);
    expect(refusalCopy({ code: 'caseworker_landlord_of_record', unitId: 'u1' })).toEqual(CONVERSION_LANDLORD);
    expect(refusalCopy({ code: 'caseworker_on_roster', unitId: 'u2' })).toEqual(ROSTER);
  });
});

describe('typeChangeRefusalCopy - the generic type change', () => {
  it('uses the conversion sentence and link for an open placement and an open tour', () => {
    expect(typeChangeRefusalCopy({ code: 'open_placement', placementId: 'p 7' })).toEqual(PLACEMENT);
    expect(typeChangeRefusalCopy({ code: 'open_tour', tourId: 't1' })).toEqual(TOUR);
  });

  it('has its own landlord-of-record sentence: no dashboard path reassigns a landlord yet', () => {
    expect(TYPE_CHANGE_LANDLORD_SENTENCE).toBe(
      "This contact is the landlord of record for a property, so they must stay a landlord. Changing a property's landlord isn't available in the dashboard yet.",
    );
    expect(typeChangeRefusalCopy({ code: 'landlord_of_record', unitId: 'u 1' })).toEqual({
      sentence: TYPE_CHANGE_LANDLORD_SENTENCE,
      linkText: 'View property',
      to: '/listings/u%201',
    });
  });
});

describe('typeChangeRefusalsFrom - the 409 type_change_refused body', () => {
  function refused(body: unknown): ApiError {
    return new ApiError(409, 'type_change_refused', 'type_change_refused', body);
  }

  it('reads every refusal, in order', () => {
    const refusals = [
      { code: 'open_placement', placementId: 'p1' },
      { code: 'open_tour', tourId: 't1' },
      { code: 'landlord_of_record', unitId: 'u1' },
    ];
    expect(typeChangeRefusalsFrom(refused({ error: 'type_change_refused', refusals }))).toEqual(refusals);
  });

  it('drops malformed entries, and answers null when none is left', () => {
    expect(
      typeChangeRefusalsFrom(
        refused({
          error: 'type_change_refused',
          refusals: [
            { code: 'open_placement' },
            { code: 'on_roster', unitId: 'u2' },
            { code: 'caseworker_open_tour', tourId: 't9' },
            'open_tour',
            null,
            { code: 'open_tour', tourId: 't1' },
          ],
        }),
      ),
    ).toEqual([{ code: 'open_tour', tourId: 't1' }]);
    expect(typeChangeRefusalsFrom(refused({ error: 'type_change_refused', refusals: [] }))).toBeNull();
    expect(typeChangeRefusalsFrom(refused({ error: 'type_change_refused' }))).toBeNull();
    expect(typeChangeRefusalsFrom(refused(undefined))).toBeNull();
  });

  it('answers null for any other failure', () => {
    const refusals = [{ code: 'open_tour', tourId: 't1' }];
    expect(
      typeChangeRefusalsFrom(
        new ApiError(409, 'caseworker_use_conversion', 'caseworker_use_conversion', {
          error: 'caseworker_use_conversion',
          refusals,
        }),
      ),
    ).toBeNull();
    expect(
      typeChangeRefusalsFrom(
        new ApiError(400, 'type_change_refused', 'type_change_refused', { error: 'type_change_refused', refusals }),
      ),
    ).toBeNull();
    expect(typeChangeRefusalsFrom(new Error('offline'))).toBeNull();
    expect(typeChangeRefusalsFrom(undefined)).toBeNull();
  });
});
