// names.ts — decoding the founder's naming conventions. Every pattern asserted
// here was observed in the real 2026-08-05 export; the sample values are
// synthetic stand-ins with the same shape.
import { describe, expect, it } from 'vitest';
import { bestDisplayName, parseName, voucherSizesSeen } from '../src/lib/import/names.js';

describe('parseName - voucher size', () => {
  it.each([
    ['Jermelle Daniel-5bed', 'Jermelle Daniel', 5],
    ['Ms. Cooper- 2 Bed', 'Ms. Cooper', 2],
    ['Maliko Hawkins-3 Bed', 'Maliko Hawkins', 3],
    ['Orlando- 1 Bed', 'Orlando', 1],
    ['Ella Kesler-3bed', 'Ella Kesler', 3],
    ['Adrianna Hayes- 2 Bed', 'Adrianna Hayes', 2],
  ])('parses %j', (raw, clean, beds) => {
    const p = parseName(raw);
    expect(p.clean).toBe(clean);
    expect(p.voucherBeds).toBe(beds);
  });

  it('leaves names without a size alone', () => {
    const p = parseName('Sabrina Johnson');
    expect(p.clean).toBe('Sabrina Johnson');
    expect(p.voucherBeds).toBeUndefined();
  });

  it('does not mistake an interior number for a voucher size', () => {
    // Anchoring the suffix is what keeps "Apt 2 Mike" and "3 bed available" out.
    expect(parseName('Apt 2 Mike').voucherBeds).toBeUndefined();
    expect(parseName('Mike 4 Bedrooms Available Now').voucherBeds).toBeUndefined();
  });
});

describe('parseName - markers', () => {
  it('detects the handshake landlord marker and strips it', () => {
    const p = parseName('\u{1F91D} Bert Jacobs');
    expect(p.isLandlordMarked).toBe(true);
    expect(p.clean).toBe('Bert Jacobs');
  });

  it('handles a handshake with no space', () => {
    expect(parseName('\u{1F91D}Cleatus').clean).toBe('Cleatus');
  });

  it('detects the star marker BETWEEN the name and the bed suffix', () => {
    // "Jasmine Maddox*-3bed": markers must be stripped before the anchored bed
    // suffix can match, or the star blocks it and the size is lost.
    const p = parseName('Jasmine Maddox*-3bed');
    expect(p.hasStarMarker).toBe(true);
    expect(p.voucherBeds).toBe(3);
    expect(p.clean).toBe('Jasmine Maddox');
  });

  it('detects a caseworker marker', () => {
    const p = parseName('Muhammad Khateeb caseworker');
    expect(p.isCaseworkerMarked).toBe(true);
    expect(p.clean).toBe('Muhammad Khateeb');
  });

  it('combines a handshake and a bed suffix', () => {
    const p = parseName('\u{1F91D} Alfred- 3bed');
    expect(p.isLandlordMarked).toBe(true);
    expect(p.voucherBeds).toBe(3);
    expect(p.clean).toBe('Alfred');
  });

  it('flags obvious test/system rows', () => {
    expect(parseName('Quo Team').isNonPerson).toBe(true);
    expect(parseName('\u{1F91D} test kelvin').isNonPerson).toBe(true);
    expect(parseName('Sabrina Johnson').isNonPerson).toBe(false);
  });

  it('yields an empty clean name when the row is only a suffix', () => {
    expect(parseName('-3bed').clean).toBe('');
  });
});

describe('bestDisplayName', () => {
  it('prefers the most complete variant across merged rows', () => {
    // A single phone carries several Quo rows; the longer form is nearly always
    // the more complete one.
    expect(bestDisplayName(['Catina', 'Catina Brown-2bed', ''])).toBe('Catina Brown');
  });

  it('returns empty when nothing is usable', () => {
    expect(bestDisplayName(['', '-2bed'])).toBe('');
  });
});

describe('voucherSizesSeen', () => {
  it('returns one size when the variants agree', () => {
    expect(voucherSizesSeen(['Catina Brown-2bed', 'Catina- 2 Bed'])).toEqual([2]);
  });

  it('surfaces a conflict rather than picking a winner', () => {
    // 12 of 478 real tenants hit this. The importer must never auto-resolve it:
    // voucher size drives matching, and a plausible guess buries a real question.
    expect(voucherSizesSeen(['Candy Faulk-3bed', 'Candy-4bed', 'Candy Faulk-4bed'])).toEqual([3, 4]);
  });

  it('returns empty when no variant carries a size', () => {
    expect(voucherSizesSeen(['Sabrina Johnson', ''])).toEqual([]);
  });
});
