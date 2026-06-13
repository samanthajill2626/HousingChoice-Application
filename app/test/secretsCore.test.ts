// Pure core of the secrets sync (scripts/secrets.mjs): dotenv parsing, value
// masking (values must never leak), and the Terraform/deploy-managed denylist.
// No AWS calls anywhere — the AWS-touching CLI shell lives in
// scripts/secrets.mjs and is account-guarded; this tests scripts/lib/secretsCore.mjs.
import { describe, expect, it } from 'vitest';
import {
  MANAGED_BY_OTHERS,
  diffKeySets,
  findDenylistedKeys,
  maskValue,
  parseDotenv,
} from '../../scripts/lib/secretsCore.mjs';

describe('parseDotenv', () => {
  it('parses KEY=value lines, skipping blanks and full-line comments', () => {
    const text = [
      '# Twilio credentials',
      '',
      'TWILIO_ACCOUNT_SID=AC123',
      '   # indented comment',
      'TWILIO_AUTH_TOKEN=tok456',
      '',
    ].join('\n');
    expect(parseDotenv(text)).toEqual({
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'tok456',
    });
  });

  it('handles CRLF line endings (the files are edited on Windows)', () => {
    expect(parseDotenv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('trims whitespace around keys, =, and unquoted values', () => {
    expect(parseDotenv('  KEY  =  value  ')).toEqual({ KEY: 'value' });
  });

  it('strips matching single or double quotes around values', () => {
    expect(parseDotenv('A="quoted value"\nB=\'single\'')).toEqual({
      A: 'quoted value',
      B: 'single',
    });
  });

  it('keeps unmatched/inner quotes and # inside values verbatim', () => {
    expect(parseDotenv('A="half\nB=pa#ss"word')).toEqual({
      A: '"half',
      B: 'pa#ss"word',
    });
  });

  it('does NOT interpolate or process escapes', () => {
    expect(parseDotenv('A=$HOME\\n${B}')).toEqual({ A: '$HOME\\n${B}' });
  });

  it('allows empty values (the CLI rejects them before pushing)', () => {
    expect(parseDotenv('A=')).toEqual({ A: '' });
  });

  it('throws on malformed lines, with the line number but NOT the content', () => {
    expect(() => parseDotenv('GOOD=1\nthis is not dotenv')).toThrowError(/line 2/);
    expect(() => parseDotenv('secret-content no equals')).not.toThrowError(/secret-content/);
  });

  it('throws on invalid key characters', () => {
    expect(() => parseDotenv('1BAD=x')).toThrowError(/line 1/);
    expect(() => parseDotenv('BAD-KEY=x')).toThrowError(/line 1/);
  });

  it('throws on duplicate keys', () => {
    expect(() => parseDotenv('A=1\nA=2')).toThrowError(/line 2: duplicate key A/);
  });
});

describe('maskValue', () => {
  it('shows at most first 2 + last 4 chars of long values', () => {
    expect(maskValue('AC0123456789abcdef1234')).toBe('AC…1234');
  });

  it('fully masks short values with a fixed-width mask (length not leaked)', () => {
    expect(maskValue('hunter2')).toBe('****');
    expect(maskValue('elevenchars')).toBe('****'); // 11 chars: still too short
    expect(maskValue('a')).toBe('****');
  });

  it('never contains the middle of the secret', () => {
    const secret = 'AC-very-secret-middle-9876';
    const masked = maskValue(secret);
    expect(masked).not.toContain('very-secret-middle');
    expect(masked.length).toBeLessThan(secret.length);
  });

  it('labels empty values', () => {
    expect(maskValue('')).toBe('(empty)');
  });
});

describe('findDenylistedKeys (Terraform/deploy-managed params)', () => {
  it('the denylist is exactly the twelve managed params', () => {
    expect([...MANAGED_BY_OTHERS].sort()).toEqual([
      'CF_ORIGIN_SECRET',
      'DEPLOYED_TAG',
      'JOBS_QUEUE_URL',
      'LOG_LEVEL',
      'MEDIA_BUCKET',
      'NODE_ENV',
      'PORT',
      'PUBLIC_BASE_URL',
      'SCHEDULER_ROLE_ARN',
      'SCHEDULER_TARGET_ARN',
      'SESSION_SECRET',
      'TABLE_PREFIX',
    ]);
  });

  it('flags denylisted keys present in a parsed file', () => {
    const keys = Object.keys(parseDotenv('TWILIO_ACCOUNT_SID=AC1\nCF_ORIGIN_SECRET=x\nPORT=8080'));
    expect(findDenylistedKeys(keys)).toEqual(['CF_ORIGIN_SECRET', 'PORT']);
  });

  it('passes a clean secrets file', () => {
    expect(
      findDenylistedKeys(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SID']),
    ).toEqual([]);
  });

  it('is case-sensitive like SSM param names (lowercase port is not the managed PORT)', () => {
    expect(findDenylistedKeys(['port'])).toEqual([]);
  });
});

describe('diffKeySets (.env.<env> vs .env.<env>.example sync rule)', () => {
  it('reports keys missing from the real file and extras not in the example, sorted', () => {
    expect(
      diffKeySets(['B_EXTRA', 'A_EXTRA', 'SHARED'], ['SHARED', 'Z_MISSING', 'C_MISSING']),
    ).toEqual({
      missing: ['C_MISSING', 'Z_MISSING'],
      extra: ['A_EXTRA', 'B_EXTRA'],
    });
  });

  it('is empty-empty when the key sets match (values are irrelevant)', () => {
    expect(diffKeySets(['A', 'B'], ['B', 'A'])).toEqual({ missing: [], extra: [] });
  });
});
