// parseUnitAddress - the reviewed workbook's single free-text address cell ->
// the structured Address the app's contract expects (lib/address.ts).
//
// Every case below mirrors a SHAPE that appears in the founder's real 100-row
// property book (fragments, missing ZIPs, mid-string ZIPs, unit designators,
// chat text wrapped around an address), but the addresses themselves are
// synthetic: her inventory is real people's homes and this repo pushes to a
// remote.
import { describe, expect, it } from 'vitest';
import { validateAddress } from '../src/lib/address.js';
import { normalizeAddress, parseUnitAddress } from '../src/lib/import/addresses.js';
import { unitIdForAddress } from '../src/lib/import/ids.js';

describe('the complete shapes', () => {
  it('splits street, city, state and ZIP', () => {
    expect(parseUnitAddress('1460 Lavender Dr NW Atlanta, GA 30314')).toEqual({
      line1: '1460 Lavender Dr NW',
      city: 'Atlanta',
      state: 'GA',
      zip: '30314',
    });
  });

  it('handles the fully comma-separated form with a unit designator', () => {
    expect(parseUnitAddress('1425 Sycamore Blvd NW, Unit 104, Decatur, GA 30030')).toEqual({
      line1: '1425 Sycamore Blvd NW',
      line2: 'Unit 104',
      city: 'Decatur',
      state: 'GA',
      zip: '30030',
    });
  });

  it('normalizes a spelled-out state to the 2-letter code', () => {
    expect(parseUnitAddress('88 Elm Ct SW Marietta, Georgia 30060').state).toBe('GA');
  });

  it('drops the "United States" tail Quo appends to a location share', () => {
    expect(parseUnitAddress('1200 Poplar St NW\nAtlanta, GA 30318\nUnited States')).toEqual({
      line1: '1200 Poplar St NW',
      city: 'Atlanta',
      state: 'GA',
      zip: '30318',
    });
  });
});

describe('what it refuses to invent', () => {
  it('leaves city and state unset when she wrote only a ZIP', () => {
    expect(parseUnitAddress('1721 Browning St SW 30314')).toEqual({
      line1: '1721 Browning St SW',
      zip: '30314',
    });
  });

  it('leaves the state unset when she wrote a city but no state', () => {
    expect(parseUnitAddress('1079 White Oak Avenue SW Atlanta 30310')).toEqual({
      line1: '1079 White Oak Avenue SW',
      city: 'Atlanta',
      zip: '30310',
    });
  });

  it.each([
    'Dean Ct.',
    'W Pike',
    'North ave',
    'Overlook Apartments',
    '944 Joseph E Boone',
    '2436 clarissa',
  ])('keeps the fragment %j whole in line1', (fragment) => {
    expect(parseUnitAddress(fragment)).toEqual({ line1: fragment });
  });
});

describe('the awkward real-world shapes', () => {
  it('takes a MID-STRING ZIP when a unit designator follows it', () => {
    expect(parseUnitAddress('672 Cameron Way NW, 30318 Unit A')).toEqual({
      line1: '672 Cameron Way NW',
      line2: 'Unit A',
      zip: '30318',
    });
  });

  it('never mistakes a leading house number for a ZIP', () => {
    // "0058 ..." opens the street line; only "30349" is postal. The 4-digit
    // suite number must not be read as a ZIP either.
    expect(parseUnitAddress('0058 Frontline-510 Plaza dr. Suite 2295, Atlanta, GA 30349')).toEqual({
      line1: '0058 Frontline-510 Plaza dr.',
      line2: 'Suite 2295',
      city: 'Atlanta',
      state: 'GA',
      zip: '30349',
    });
  });

  it('keeps a city name that is part of the STREET, not the postal tail', () => {
    // The city is only taken when it TRAILS the remaining text - otherwise
    // "1234 College Park Dr" would lose its street name.
    expect(parseUnitAddress('1234 College Park Dr')).toEqual({ line1: '1234 College Park Dr' });
  });

  it('still splits the postal tail when the street carries a city name', () => {
    expect(parseUnitAddress('1234 College Park Dr Smyrna, GA 30080')).toEqual({
      line1: '1234 College Park Dr',
      city: 'Smyrna',
      state: 'GA',
      zip: '30080',
    });
  });

  it('preserves chat text wrapped around an address rather than silently trimming it', () => {
    // Three cells in the real book still carry her message text. Parsing the
    // postal tail off them is right; QUIETLY deleting the rest is not - the
    // junk is the signal that the cell needs a human (workbook cleanup).
    expect(parseUnitAddress('2 bath here. 280 Richardson Rd NW Atlanta, GA 30314')).toEqual({
      line1: '2 bath here. 280 Richardson Rd NW',
      city: 'Atlanta',
      state: 'GA',
      zip: '30314',
    });
  });

  it('keeps a bare designator as the street line rather than emptying line1', () => {
    expect(parseUnitAddress('Unit 2')).toEqual({ line1: 'Unit 2' });
  });

  it('keeps a bare city as the street line rather than emptying line1', () => {
    expect(parseUnitAddress('Atlanta')).toEqual({ line1: 'Atlanta' });
  });

  it('returns an empty address for an empty cell', () => {
    expect(parseUnitAddress('   ')).toEqual({});
  });
});

describe('the contracts this has to satisfy', () => {
  const CORPUS_SHAPES = [
    '1460 Lavender Dr NW Atlanta, GA 30314',
    '1721 Browning St SW 30314',
    '672 Cameron Way NW, 30318 Unit A',
    '846 Durant Pl NE Unit 5, Atlanta, GA 30308',
    '0058 Frontline-510 Plaza dr. Suite 2295, Atlanta, GA 30349',
    '2 bath here. 280 Richardson Rd NW Atlanta, GA 30314',
    '404 Corvair Drive Atlanta',
    'Overlook Apartments',
    'Dean Ct.',
    '2 burbank',
  ];

  it('every parse passes the write-surface validator the flyer re-checks', () => {
    // toUnitFlyer runs validateAddress and substitutes {} on failure - which is
    // exactly how a plain string became "no address on the flyer". A parse that
    // cannot survive that check would reproduce the bug in a new shape.
    for (const raw of CORPUS_SHAPES) {
      const result = validateAddress(parseUnitAddress(raw), 'address');
      expect(result.ok, `${raw} -> ${JSON.stringify(parseUnitAddress(raw))}`).toBe(true);
    }
  });

  it('never loses the street text', () => {
    // Whatever else it does, the house number and street must survive: the
    // street line is what a tenant navigates by (formatStreet feeds tour SMS).
    for (const raw of CORPUS_SHAPES) {
      const parsed = parseUnitAddress(raw);
      expect(parsed.line1, raw).toBeTruthy();
      const head = raw.match(/^\D*(\d{1,6})\s/);
      if (head) expect(parsed.line1, raw).toContain(head[1]);
    }
  });

  it('leaves the unitId seed untouched, so a re-run converges instead of duplicating', () => {
    // The identity contract: unitId comes from the RAW normalized cell. If a
    // future change ever seeds it from the parsed parts, the whole book
    // re-mints and every property doubles on the next import.
    for (const raw of CORPUS_SHAPES) {
      expect(unitIdForAddress(normalizeAddress(raw))).toBe(unitIdForAddress(normalizeAddress(raw)));
    }
    expect(unitIdForAddress(normalizeAddress('1460 Lavender Dr NW Atlanta, GA 30314'))).not.toBe(
      unitIdForAddress(normalizeAddress('1460 Lavender Dr NW')),
    );
  });
});
