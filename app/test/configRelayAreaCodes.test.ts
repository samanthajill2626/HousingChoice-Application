// app/test/configRelayAreaCodes.test.ts
//
// relayPreferredAreaCodes parsing (relay area-code preference):
//   unset            -> the Atlanta-metro default list
//   set (csv)        -> trimmed entries, empties dropped
//   set empty        -> [] (no preference - ladder degrades to bare search)
//   malformed entry  -> loud throw (fail-fast, like RELAY_SPARE_BUFFER_TARGET)
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const base = { CF_ORIGIN_SECRET: 's', NODE_ENV: 'development' };

describe('relayPreferredAreaCodes resolution', () => {
  it('defaults to the Atlanta-metro list when unset', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.relayPreferredAreaCodes).toEqual(['404', '470', '678', '770', '943']);
  });

  it('parses a custom comma-separated list, trimming whitespace and dropping empties', () => {
    const cfg = loadConfig({ ...base, RELAY_PREFERRED_AREA_CODES: ' 912 , 229 ,, 478 ' });
    expect(cfg.relayPreferredAreaCodes).toEqual(['912', '229', '478']);
  });

  it('an explicitly EMPTY value means no preference ([])', () => {
    const cfg = loadConfig({ ...base, RELAY_PREFERRED_AREA_CODES: '' });
    expect(cfg.relayPreferredAreaCodes).toEqual([]);
  });

  it('rejects a non-3-digit entry loudly (fail-fast on a typo)', () => {
    expect(() => loadConfig({ ...base, RELAY_PREFERRED_AREA_CODES: '404,47a' })).toThrow(
      /RELAY_PREFERRED_AREA_CODES/,
    );
    expect(() => loadConfig({ ...base, RELAY_PREFERRED_AREA_CODES: '4040' })).toThrow(
      /RELAY_PREFERRED_AREA_CODES/,
    );
  });

  it('rejects a 3-digit NON-NANP entry (first digit must be 2-9)', () => {
    // '044' would reach the driver as Number('044') === 44 - a code nobody typed,
    // and a Twilio 4xx there ABORTS the warm ladder instead of advancing it.
    expect(() => loadConfig({ ...base, RELAY_PREFERRED_AREA_CODES: '044' })).toThrow(
      /RELAY_PREFERRED_AREA_CODES/,
    );
    expect(() => loadConfig({ ...base, RELAY_PREFERRED_AREA_CODES: '404,104' })).toThrow(
      /RELAY_PREFERRED_AREA_CODES/,
    );
  });
});
