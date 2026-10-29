// WP1 B2a spec D19, PR30, PR35: the ranking variables in the env example
// files. Every value an example SETS is the default and never blank (PR35:
// secrets push / check refuse an empty value). RANKING_DRIVER and
// RANKING_WORKER_POLL are mode-dependent (PR30), so the examples a laptop
// loads in live mode (.env, .env.dev) document them as comments instead of
// pinning a value that would beat the mode default.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AI_PRICE_TABLE, loadConfig } from '../src/lib/config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULTS: Record<string, string> = {
  AI_RANKING_MODEL: 'claude-sonnet-5-5',
  RANKING_EFFORT: 'low',
  RANKING_MAX_OUTPUT_TOKENS: '16000',
  RANKING_CALL_TIMEOUT_MS: '120000',
  RANKING_BATCH_SIZE: '40',
  RANKING_BATCH_CONCURRENCY: '4',
  RANKING_MAX_CONCURRENT_JOBS: '2',
  RANKING_LEASE_MS: '90000',
  RANKING_QUEUE_EXPIRY_MS: '600000',
  RANKING_POOL_WINDOW_DAYS: '90',
  RANKING_MAX_POOL: '300',
  RANKING_SEEN_MAX: '8',
  RANKING_MAX_AGE_DAYS: '7',
  RANKING_PAIR_TTL_DAYS: '180',
  RANKING_PRIORITY_STRENGTH: 'within_band',
  RANKING_LANDLORD_CARD: 'false',
  RANKING_READ_CONCURRENCY: '16',
  RATE_LIMIT_RANK_PER_MIN: '6',
  AI_PRICE_TABLE: '{"claude-sonnet-5-5":{"in":2,"out":10},"claude-opus-5-5":{"in":4,"out":20}}',
};

/** Per file: the value each mode-dependent key is SET to, or null when it is only a comment (PR30). */
const MODE_KEYS: Record<string, { RANKING_DRIVER: string | null; RANKING_WORKER_POLL: string | null }> = {
  '.env.example': { RANKING_DRIVER: null, RANKING_WORKER_POLL: null },
  '.env.dev.example': { RANKING_DRIVER: 'anthropic', RANKING_WORKER_POLL: null },
  '.env.prod.example': { RANKING_DRIVER: 'anthropic', RANKING_WORKER_POLL: 'on' },
};

function fileText(file: string): string {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

function keyLines(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of fileText(file).split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
    if (match) out.set(match[1]!, match[2]!);
  }
  return out;
}

describe.each(Object.keys(MODE_KEYS))('%s', (file) => {
  const keys = keyLines(file);
  const mode = MODE_KEYS[file]!;

  it('sets every mode-independent D19 variable to its default', () => {
    for (const [key, value] of Object.entries(DEFAULTS)) expect(keys.get(key), `${file} ${key}`).toBe(value);
  });

  it('sets the mode-dependent keys as PR30 allows, and documents an unset one as a comment', () => {
    for (const key of ['RANKING_DRIVER', 'RANKING_WORKER_POLL'] as const) {
      const expected = mode[key];
      if (expected === null) {
        expect(keys.has(key), `${file} must not SET ${key}`).toBe(false);
        expect(fileText(file), `${file} documents ${key}`).toMatch(new RegExp(`^# ${key}=`, 'm'));
      } else {
        expect(keys.get(key), `${file} ${key}`).toBe(expected);
      }
    }
  });

  it('never sets a ranking variable to a blank value (PR35) or the worker poll to off', () => {
    for (const [key, value] of keys) {
      if (key.startsWith('RANKING_') || key === 'AI_RANKING_MODEL' || key === 'AI_PRICE_TABLE' || key === 'RATE_LIMIT_RANK_PER_MIN') {
        expect(value.trim().length, `${file} ${key} is blank`).toBeGreaterThan(0);
      }
    }
    expect(keys.get('RANKING_WORKER_POLL')).not.toBe('off');
  });
});

describe('the example values parse through production loadConfig', () => {
  function rankingEnv(file: string): Record<string, string> {
    const keys = keyLines(file);
    const env: Record<string, string> = {};
    for (const [key, value] of keys) {
      if (key.startsWith('RANKING_') || ['AI_RANKING_MODEL', 'AI_PRICE_TABLE', 'RATE_LIMIT_RANK_PER_MIN'].includes(key)) env[key] = value;
    }
    return env;
  }

  it('.env.example on DynamoDB Local: the console driver and the poll on, every default', () => {
    const cfg = loadConfig({ CF_ORIGIN_SECRET: 's', NODE_ENV: 'development', DYNAMODB_ENDPOINT: 'http://localhost:8000', ...rankingEnv('.env.example') });
    expect(cfg.rankingDriver).toBe('console');
    expect(cfg.rankingWorkerPoll).toBe(true);
    expect(cfg.aiRankingModel).toBe('claude-sonnet-5-5');
    expect(cfg.rankingEffort).toBe('low');
    expect(cfg.rankingLandlordCard).toBe(false);
    expect(cfg.aiPriceTable).toEqual(DEFAULT_AI_PRICE_TABLE);
  });

  it('.env.dev.example in live local dev (real tables, no endpoint): anthropic, and the laptop does NOT poll (PR30)', () => {
    const cfg = loadConfig({
      CF_ORIGIN_SECRET: 's',
      NODE_ENV: 'development',
      ANTHROPIC_API_KEY: 'sk-test-not-a-real-key',
      ...rankingEnv('.env.dev.example'),
      ...rankingEnv('.env.example'),
    });
    expect(cfg.rankingDriver).toBe('anthropic');
    expect(cfg.rankingWorkerPoll).toBe(false);
  });
});
