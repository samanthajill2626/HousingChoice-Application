// Pure core of the secrets sync (scripts/secrets.mjs): dotenv parsing, value
// masking (values must never leak), and the Terraform/deploy-managed denylist.
// No AWS calls anywhere — the AWS-touching CLI shell lives in
// scripts/secrets.mjs and is account-guarded; this tests scripts/lib/secretsCore.mjs.
import { describe, expect, it } from 'vitest';
import {
  MANAGED_BY_OTHERS,
  diffKeySets,
  findDenylistedKeys,
  findOrphanParams,
  maskValue,
  parseDotenv,
  syncEnvFromExample,
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

describe('findOrphanParams (SSM params no longer backed by .env.<env>)', () => {
  it('returns SSM keys absent from the env file, sorted', () => {
    // OLD_KEY and GONE were removed from .env.<env>; the Twilio key still lives there.
    expect(
      findOrphanParams(['TWILIO_API_KEY_SID', 'OLD_KEY', 'GONE'], ['TWILIO_API_KEY_SID']),
    ).toEqual(['GONE', 'OLD_KEY']);
  });

  it('never returns a Terraform/deploy-managed key, even when absent from the env file', () => {
    // SESSION_SECRET/DEPLOYED_TAG live in SSM by design and are never in .env — only STALE is an orphan.
    expect(
      findOrphanParams(['SESSION_SECRET', 'DEPLOYED_TAG', 'STALE'], ['TWILIO_API_KEY_SID']),
    ).toEqual(['STALE']);
  });

  it('returns [] when every SSM key is either in the env file or Terraform/deploy-managed', () => {
    expect(
      findOrphanParams(['TWILIO_API_KEY_SID', 'PORT', 'SESSION_SECRET'], ['TWILIO_API_KEY_SID']),
    ).toEqual([]);
  });

  it('returns [] when there are no SSM params under the path', () => {
    expect(findOrphanParams([], ['TWILIO_API_KEY_SID'])).toEqual([]);
  });

  it('is case-sensitive like SSM param names (a lowercase "port" is an orphan, not the managed PORT)', () => {
    expect(findOrphanParams(['port'], [])).toEqual(['port']);
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

describe('syncEnvFromExample (template-first: comments/structure from example, values from real)', () => {
  it('preserves the real value VERBATIM for values containing =, quotes, and spaces', () => {
    const example = [
      '# api creds',
      'WITH_EQUALS=placeholder',
      'DQUOTED=placeholder',
      'SQUOTED=placeholder',
      'PADDED=placeholder',
    ].join('\n');
    const real = [
      '# api creds',
      'WITH_EQUALS=a=b=c', // inner = signs
      'DQUOTED="quoted value"', // double quotes kept
      "SQUOTED='single'", // single quotes kept
      'PADDED=  spaced  ', // leading/trailing spaces kept
    ].join('\n');
    const { output } = syncEnvFromExample(example, real);
    expect(output).toBe(real); // byte-for-byte: no parse/unquote round-trip
  });

  it('emits an empty value (KEY=) for a brand-new key in the example', () => {
    const example = ['EXISTING=x', '# a new secret', 'NEW_KEY=replace-me'].join('\n');
    const real = 'EXISTING=realvalue';
    const { output, summary } = syncEnvFromExample(example, real);
    expect(output).toBe(['EXISTING=realvalue', '# a new secret', 'NEW_KEY='].join('\n'));
    expect(summary.newKeys).toEqual(['NEW_KEY']);
    expect(summary.preservedKeys).toEqual(['EXISTING']);
    expect(summary.changed).toBe(true);
  });

  it('preserves an empty real value as KEY= (empty stays empty)', () => {
    const { output, summary } = syncEnvFromExample('A=placeholder', 'A=');
    expect(output).toBe('A=');
    // An empty real value still counts as "present" — it is preserved, not new.
    expect(summary.preservedKeys).toEqual(['A']);
    expect(summary.newKeys).toEqual([]);
  });

  it('propagates a comment EDIT from the example while preserving the value', () => {
    const example = ['# NEW comment text', 'TOKEN=placeholder'].join('\n');
    const real = ['# OLD comment text', 'TOKEN=s3cr3t-token-value'].join('\n');
    const { output, summary } = syncEnvFromExample(example, real);
    expect(output).toBe(['# NEW comment text', 'TOKEN=s3cr3t-token-value'].join('\n'));
    expect(summary.changed).toBe(true); // comment changed even though value did not
  });

  it('emits blank lines and comments from the example VERBATIM', () => {
    const example = ['# header', '', '# section', 'A=ph', '', 'B=ph'].join('\n');
    const real = ['A=1', 'B=2'].join('\n');
    const { output } = syncEnvFromExample(example, real);
    expect(output).toBe(['# header', '', '# section', 'A=1', '', 'B=2'].join('\n'));
  });

  it('follows the EXAMPLE key order, not the real file order', () => {
    const example = ['C=ph', 'A=ph', 'B=ph'].join('\n');
    const real = ['A=1', 'B=2', 'C=3'].join('\n'); // different order
    const { output } = syncEnvFromExample(example, real);
    expect(output).toBe(['C=3', 'A=1', 'B=2'].join('\n'));
  });

  it('preserves an extra real key under a generated section and lists it in extraKeys', () => {
    const example = ['A=ph'].join('\n');
    const real = ['A=1', 'LEGACY_KEY=keepme', 'ANOTHER_EXTRA=also'].join('\n');
    const { output, summary } = syncEnvFromExample(example, real);
    expect(output).toBe(
      [
        'A=1',
        '',
        '# --- Keys not in the template (review/remove) ---',
        'LEGACY_KEY=keepme',
        'ANOTHER_EXTRA=also',
      ].join('\n'),
    );
    expect(summary.extraKeys).toEqual(['LEGACY_KEY', 'ANOTHER_EXTRA']);
    expect(summary.changed).toBe(true);
  });

  it('never silently drops an extra key even when its value contains tricky bytes', () => {
    const example = 'A=ph';
    const real = ['A=1', 'EXTRA="weird = value"'].join('\n');
    const { output, summary } = syncEnvFromExample(example, real);
    expect(output).toContain('EXTRA="weird = value"');
    expect(summary.extraKeys).toEqual(['EXTRA']);
  });

  it('reports changed=false when the real file already mirrors the example', () => {
    const example = ['# c', 'A=ph', 'B=ph'].join('\n');
    const real = ['# c', 'A=1', 'B=2'].join('\n');
    const { summary } = syncEnvFromExample(example, real);
    expect(summary.changed).toBe(false);
  });

  it('is idempotent: syncing the output again yields byte-identical output', () => {
    const example = [
      '# header comment',
      '',
      'A=ph',
      '# mid comment',
      'B=ph',
      'NEW=ph',
    ].join('\n');
    const real = ['A=val-a', 'B=val=b', 'EXTRA=drifted'].join('\n');
    const once = syncEnvFromExample(example, real).output;
    const twice = syncEnvFromExample(example, once).output;
    expect(twice).toBe(once);
  });

  it('matches the EOL style of the example (CRLF in -> CRLF out)', () => {
    const example = 'A=ph\r\n# comment\r\nB=ph\r\n';
    const real = 'A=1\nB=2\n'; // real is LF; output must follow the example (CRLF)
    const { output } = syncEnvFromExample(example, real);
    expect(output).toBe('A=1\r\n# comment\r\nB=2\r\n');
    expect(output).not.toMatch(/[^\r]\n/); // every \n is preceded by \r
  });

  it('throws if the example contains a denylisted (Terraform/deploy-managed) key', () => {
    expect(() => syncEnvFromExample('A=ph\nPORT=8080', 'A=1')).toThrowError(/PORT/);
  });

  it('the summary never contains a value — key names only', () => {
    const example = ['A=ph', 'NEW=ph'].join('\n');
    const real = ['A=super-secret-value', 'EXTRA=another-secret'].join('\n');
    const { summary } = syncEnvFromExample(example, real);
    const blob = JSON.stringify(summary);
    expect(blob).not.toContain('super-secret-value');
    expect(blob).not.toContain('another-secret');
    expect(summary.newKeys).toEqual(['NEW']);
    expect(summary.preservedKeys).toEqual(['A']);
    expect(summary.extraKeys).toEqual(['EXTRA']);
  });

  it('propagates malformed-dotenv errors with line numbers but not content', () => {
    expect(() => syncEnvFromExample('A=ph', 'GOOD=1\nthis is not dotenv')).toThrowError(/line 2/);
    expect(() => syncEnvFromExample('A=ph', 'secret-content no equals')).not.toThrowError(
      /secret-content/,
    );
  });
});
