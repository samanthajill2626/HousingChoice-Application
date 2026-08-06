// The durable guard from docs/issues/sms-copy-non-gsm7-characters.md.
//
// This asserts ASCII, which is STRICTER than GSM-7 - it rejects characters GSM-7
// would happily price at one septet (POUND SIGN, E-ACUTE, N-TILDE). That is
// deliberate: ASCII is a rule a human can apply by eye and a reviewer can enforce
// without consulting a table. Do NOT "fix" this into a GSM-7 check - that would
// let the em dash's cousins back in.
//
// It covers OUR strings only. User-supplied values (unit addresses, operator
// overrides, contact names) pass through verbatim by design (spec D6) and are
// never asserted here.
import { describe, expect, it } from 'vitest';
import { MESSAGE_CATALOG } from '../src/messages/catalog.js';
import { analyzeSms } from '../src/lib/smsEncoding.js';

const NON_ASCII = /[^\x09\x0a\x0d\x20-\x7e]/g;

describe('message catalog: every SMS default is ASCII', () => {
  for (const def of Object.values(MESSAGE_CATALOG)) {
    if (def.channel !== 'sms') continue;
    it(`${def.id} default is ASCII`, () => {
      const offenders = [...new Set(def.default.match(NON_ASCII) ?? [])];
      const named = offenders
        .map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)
        .join(' ');
      expect(offenders, `${def.id} contains non-ASCII: ${named}`).toEqual([]);
    });
  }
});

describe('message catalog: SMS defaults are GSM-7 (implied by ASCII)', () => {
  for (const def of Object.values(MESSAGE_CATALOG)) {
    if (def.channel !== 'sms') continue;
    it(`${def.id} encodes as GSM-7`, () => {
      expect(analyzeSms(def.default).encoding).toBe('GSM-7');
    });
  }
});
