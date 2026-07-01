// Unit tests for the pure cell-verification helpers (Voice Phase 1, spec §7).
import { describe, expect, it } from 'vitest';
import {
  CELL_VERIFY_MAX_ATTEMPTS,
  CELL_VERIFY_TTL_MS,
  generateCellVerifyCode,
  hashCellVerifyCode,
  renderCellVerifySms,
} from '../src/lib/cellVerification.js';

describe('generateCellVerifyCode', () => {
  it('is always exactly 6 numeric digits (incl. leading zeros)', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateCellVerifyCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe('hashCellVerifyCode', () => {
  it('is deterministic for the same code', () => {
    expect(hashCellVerifyCode('123456')).toBe(hashCellVerifyCode('123456'));
  });

  it('differs for different codes', () => {
    expect(hashCellVerifyCode('123456')).not.toBe(hashCellVerifyCode('654321'));
  });

  it('is a 64-char lowercase hex sha256 digest (never the plaintext code)', () => {
    const hash = hashCellVerifyCode('000000');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('000000');
  });
});

describe('renderCellVerifySms', () => {
  it('contains the code', () => {
    expect(renderCellVerifySms('427193')).toContain('427193');
  });

  it('mentions HousingChoice and the 10-minute expiry', () => {
    const body = renderCellVerifySms('111111');
    expect(body).toContain('HousingChoice');
    expect(body).toContain('10 minutes');
  });
});

describe('constants', () => {
  it('TTL is 10 minutes and max attempts is 5', () => {
    expect(CELL_VERIFY_TTL_MS).toBe(10 * 60 * 1000);
    expect(CELL_VERIFY_MAX_ATTEMPTS).toBe(5);
  });
});
