// app/test/configRanking.test.ts
//
// WP1 B2a spec D6, D19 (plan PR4, WI6): every ranking variable, its default,
// and the one parse rule - unset, or blank after the trim, is the default;
// anything else is parsed strictly and a bad value refuses to start. Enum
// values are case-folded; model ids compare exactly.
import { describe, expect, it } from 'vitest';
import {
  AI_RANKING_MODEL_DEFAULT,
  DEFAULT_AI_PRICE_TABLE,
  RANKING_SUPPORTED_MODELS,
  isLocalDynamoTarget,
  loadConfig,
  parseAiPriceTable,
  parseRankingConfig,
} from '../src/lib/config.js';

/** DynamoDB Local: the hermetic lane and the dev loop's local mode (PR30). */
const LOCAL = { DYNAMODB_ENDPOINT: 'http://localhost:8000' };
const dev = { NODE_ENV: 'development', CF_ORIGIN_SECRET: 's', ...LOCAL };
/** No endpoint: `npm run dev` live mode against hosted dev's REAL tables (PR30). */
const live = { NODE_ENV: 'development', CF_ORIGIN_SECRET: 's' };

const DEFAULTS = {
  rankingDriver: 'console',
  aiRankingModel: 'claude-sonnet-5-5',
  rankingEffort: 'low',
  rankingMaxOutputTokens: 16000,
  rankingCallTimeoutMs: 120000,
  rankingBatchSize: 40,
  rankingBatchConcurrency: 4,
  rankingMaxConcurrentJobs: 2,
  rankingLeaseMs: 90000,
  rankingQueueExpiryMs: 600000,
  rankingPoolWindowDays: 90,
  rankingMaxPool: 300,
  rankingSeenMax: 8,
  rankingMaxAgeDays: 7,
  rankingPairTtlDays: 180,
  rankingPriorityStrength: 'within_band',
  rankingLandlordCard: false,
  rankingReadConcurrency: 16,
  rateLimitRankPerMin: 6,
  aiPriceTable: {
    'claude-sonnet-5-5': { in: 2, out: 10 },
    'claude-opus-5-5': { in: 4, out: 20 },
  },
  rankingWorkerPoll: true,
};

/** Every positive-integer variable with its AppConfig field. */
const POSITIVE_INTEGERS: Array<[string, keyof typeof DEFAULTS]> = [
  ['RANKING_MAX_OUTPUT_TOKENS', 'rankingMaxOutputTokens'],
  ['RANKING_CALL_TIMEOUT_MS', 'rankingCallTimeoutMs'],
  ['RANKING_BATCH_SIZE', 'rankingBatchSize'],
  ['RANKING_BATCH_CONCURRENCY', 'rankingBatchConcurrency'],
  ['RANKING_MAX_CONCURRENT_JOBS', 'rankingMaxConcurrentJobs'],
  ['RANKING_LEASE_MS', 'rankingLeaseMs'],
  ['RANKING_QUEUE_EXPIRY_MS', 'rankingQueueExpiryMs'],
  ['RANKING_POOL_WINDOW_DAYS', 'rankingPoolWindowDays'],
  ['RANKING_MAX_POOL', 'rankingMaxPool'],
  ['RANKING_SEEN_MAX', 'rankingSeenMax'],
  ['RANKING_MAX_AGE_DAYS', 'rankingMaxAgeDays'],
  ['RANKING_PAIR_TTL_DAYS', 'rankingPairTtlDays'],
  ['RANKING_READ_CONCURRENCY', 'rankingReadConcurrency'],
  ['RATE_LIMIT_RANK_PER_MIN', 'rateLimitRankPerMin'],
];

/** Every variable spec D19 adds (for the blank-is-default case). */
const ALL_VARIABLES = [
  'RANKING_DRIVER',
  'AI_RANKING_MODEL',
  'RANKING_EFFORT',
  ...POSITIVE_INTEGERS.map(([name]) => name),
  'RANKING_PRIORITY_STRENGTH',
  'RANKING_LANDLORD_CARD',
  'AI_PRICE_TABLE',
  'RANKING_WORKER_POLL',
];

describe('ranking config defaults (spec D19)', () => {
  it('applies every default on local tables outside production (console driver, the ranking poll on)', () => {
    expect(loadConfig({ ...dev })).toMatchObject(DEFAULTS);
    expect(loadConfig({ NODE_ENV: 'test', ...LOCAL }).rankingDriver).toBe('console');
  });

  it('the fields are exactly the PR4 names, and loadConfig carries what parseRankingConfig returns', () => {
    const ranking = parseRankingConfig({ ...LOCAL, RANKING_BATCH_SIZE: '12' }, 'development');
    expect(Object.keys(ranking).sort()).toEqual(Object.keys(DEFAULTS).sort());
    const cfg = loadConfig({ ...dev, RANKING_BATCH_SIZE: '12' });
    for (const [key, value] of Object.entries(ranking)) {
      expect(cfg[key as keyof typeof ranking], key).toEqual(value);
    }
    expect(cfg.rankingBatchSize).toBe(12);
  });

  it('the model default and the supported set (spec D6)', () => {
    expect(AI_RANKING_MODEL_DEFAULT).toBe('claude-sonnet-5-5');
    expect([...RANKING_SUPPORTED_MODELS]).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5']);
  });

  it('the built-in price table is the spec D6 table, handed out as a copy', () => {
    expect(DEFAULT_AI_PRICE_TABLE).toEqual(DEFAULTS.aiPriceTable);
    const cfg = loadConfig({ ...dev });
    cfg.aiPriceTable['claude-sonnet-5-5'] = { in: 99, out: 99 };
    expect(DEFAULT_AI_PRICE_TABLE['claude-sonnet-5-5']).toEqual({ in: 2, out: 10 });
    expect(loadConfig({ ...dev }).aiPriceTable['claude-sonnet-5-5']).toEqual({ in: 2, out: 10 });
  });

  it.each(ALL_VARIABLES)('%s: a blank value is the default', (name) => {
    expect(loadConfig({ ...dev, [name]: '   ' })).toMatchObject(DEFAULTS);
    expect(loadConfig({ ...dev, [name]: '' })).toMatchObject(DEFAULTS);
  });
});

describe('ranking config overrides', () => {
  it('honors every variable, trimmed, enum values case-folded', () => {
    const cfg = loadConfig({
      ...dev,
      RANKING_DRIVER: ' FAKE ',
      AI_RANKING_MODEL: ' claude-opus-5-5 ',
      RANKING_EFFORT: 'Medium',
      RANKING_MAX_OUTPUT_TOKENS: '8000',
      RANKING_CALL_TIMEOUT_MS: '60000',
      RANKING_BATCH_SIZE: '20',
      RANKING_BATCH_CONCURRENCY: '2',
      RANKING_MAX_CONCURRENT_JOBS: '1',
      RANKING_LEASE_MS: '30000',
      RANKING_QUEUE_EXPIRY_MS: '120000',
      RANKING_POOL_WINDOW_DAYS: '30',
      RANKING_MAX_POOL: '50',
      RANKING_SEEN_MAX: '4',
      RANKING_MAX_AGE_DAYS: '3',
      RANKING_PAIR_TTL_DAYS: '90',
      RANKING_PRIORITY_STRENGTH: ' ALWAYS_FIRST ',
      RANKING_LANDLORD_CARD: 'Yes',
      RANKING_READ_CONCURRENCY: '4',
      RATE_LIMIT_RANK_PER_MIN: '3',
      AI_PRICE_TABLE: '{"claude-opus-5-5":{"in":4,"out":20}}',
      RANKING_WORKER_POLL: 'OFF',
    });
    expect(cfg).toMatchObject({
      rankingDriver: 'fake',
      aiRankingModel: 'claude-opus-5-5',
      rankingEffort: 'medium',
      rankingMaxOutputTokens: 8000,
      rankingCallTimeoutMs: 60000,
      rankingBatchSize: 20,
      rankingBatchConcurrency: 2,
      rankingMaxConcurrentJobs: 1,
      rankingLeaseMs: 30000,
      rankingQueueExpiryMs: 120000,
      rankingPoolWindowDays: 30,
      rankingMaxPool: 50,
      rankingSeenMax: 4,
      rankingMaxAgeDays: 3,
      rankingPairTtlDays: 90,
      rankingPriorityStrength: 'always_first',
      rankingLandlordCard: true,
      rankingReadConcurrency: 4,
      rateLimitRankPerMin: 3,
      aiPriceTable: { 'claude-opus-5-5': { in: 4, out: 20 } },
      rankingWorkerPoll: false,
    });
  });

  it.each(POSITIVE_INTEGERS)('%s refuses anything but a positive whole number', (name) => {
    for (const bad of ['0', '-1', '1.5', 'abc', '1e3', '0x10', '12a', '+5']) {
      expect(() => loadConfig({ ...dev, [name]: bad }), `${name}=${bad}`).toThrow(
        new RegExp(`${name} must be a positive integer`),
      );
    }
  });

  it('accepts every driver and every effort level the API takes', () => {
    for (const driver of ['anthropic', 'console', 'fake']) {
      expect(loadConfig({ ...dev, RANKING_DRIVER: driver }).rankingDriver).toBe(driver);
    }
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(loadConfig({ ...dev, RANKING_EFFORT: effort }).rankingEffort).toBe(effort);
    }
    for (const strength of ['within_band', 'one_band_up', 'always_first']) {
      expect(loadConfig({ ...dev, RANKING_PRIORITY_STRENGTH: strength }).rankingPriorityStrength).toBe(strength);
    }
  });

  it('RANKING_LANDLORD_CARD reads true/1/yes and false/0/no', () => {
    for (const on of ['true', '1', 'yes', 'TRUE']) {
      expect(loadConfig({ ...dev, RANKING_LANDLORD_CARD: on }).rankingLandlordCard).toBe(true);
    }
    for (const off of ['false', '0', 'no', 'No']) {
      expect(loadConfig({ ...dev, RANKING_LANDLORD_CARD: off }).rankingLandlordCard).toBe(false);
    }
  });

  it('RANKING_WORKER_POLL reads on and off', () => {
    expect(loadConfig({ ...dev, RANKING_WORKER_POLL: 'on' }).rankingWorkerPoll).toBe(true);
    expect(loadConfig({ ...dev, RANKING_WORKER_POLL: 'off' }).rankingWorkerPoll).toBe(false);
  });

  it.each([
    ['RANKING_DRIVER', 'twilio'],
    ['RANKING_EFFORT', 'none'],
    ['RANKING_EFFORT', 'minimal'],
    ['RANKING_PRIORITY_STRENGTH', 'two_bands_up'],
    ['RANKING_LANDLORD_CARD', 'maybe'],
    ['RANKING_WORKER_POLL', 'false'],
    ['RANKING_WORKER_POLL', 'paused'],
  ])('%s refuses %s', (name, bad) => {
    expect(() => loadConfig({ ...dev, [name]: bad })).toThrow(new RegExp(`${name} must be one of`));
  });

  it.each(['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-5-5', 'CLAUDE-SONNET-5-5', 'gpt-x'])(
    'AI_RANKING_MODEL=%s stops startup (the thinking trap, spec D6)',
    (model) => {
      expect(() => loadConfig({ ...dev, AI_RANKING_MODEL: model })).toThrow(
        /AI_RANKING_MODEL must be one of claude-sonnet-5-5, claude-opus-5-5/,
      );
    },
  );

  it('RANKING_PAIR_TTL_DAYS below RANKING_MAX_AGE_DAYS stops startup (charter 10.2)', () => {
    expect(() => loadConfig({ ...dev, RANKING_PAIR_TTL_DAYS: '6' })).toThrow(
      /RANKING_PAIR_TTL_DAYS \(6\) must be at least RANKING_MAX_AGE_DAYS \(7\)/,
    );
    expect(loadConfig({ ...dev, RANKING_PAIR_TTL_DAYS: '7' }).rankingPairTtlDays).toBe(7);
  });
});

describe('AI_PRICE_TABLE (spec D6)', () => {
  it('an override REPLACES the built-in table whole', () => {
    expect(loadConfig({ ...dev, AI_PRICE_TABLE: '{"claude-sonnet-5-5":{"in":3,"out":15}}' }).aiPriceTable).toEqual({
      'claude-sonnet-5-5': { in: 3, out: 15 },
    });
  });

  it('accepts zero and fractional prices, and the parser is exported for the scripts', () => {
    expect(parseAiPriceTable('{"claude-opus-5-5":{"in":0,"out":0.5}}')).toEqual({
      'claude-opus-5-5': { in: 0, out: 0.5 },
    });
    expect(parseAiPriceTable(undefined)).toEqual(DEFAULTS.aiPriceTable);
    expect(parseAiPriceTable('  ')).toEqual(DEFAULTS.aiPriceTable);
  });

  it.each([
    ['not JSON', '{in:2'],
    ['an array', '[]'],
    ['a number', '5'],
    ['null', 'null'],
    ['an entry that is not an object', '{"claude-sonnet-5-5":2}'],
    ['an entry missing out', '{"claude-sonnet-5-5":{"in":2}}'],
    ['an entry with an extra key', '{"claude-sonnet-5-5":{"in":2,"out":10,"cache":1}}'],
    ['a negative price', '{"claude-sonnet-5-5":{"in":-1,"out":10}}'],
    ['a price written as a string', '{"claude-sonnet-5-5":{"in":"2","out":10}}'],
    ['a padded model id', '{" claude-sonnet-5-5":{"in":2,"out":10}}'],
    ['a prototype key', '{"__proto__":{"in":2,"out":10}}'],
  ])('refuses %s', (_label, raw) => {
    expect(() => loadConfig({ ...dev, AI_PRICE_TABLE: raw })).toThrow(/AI_PRICE_TABLE must be a JSON object/);
  });

  it('a ranking model with no price stops startup (every run records its cost)', () => {
    expect(() => loadConfig({ ...dev, AI_PRICE_TABLE: '{"claude-opus-5-5":{"in":4,"out":20}}' })).toThrow(
      /AI_PRICE_TABLE has no price for the ranking model claude-sonnet-5-5/,
    );
    expect(() => loadConfig({ ...dev, AI_PRICE_TABLE: '{}' })).toThrow(/no price for the ranking model/);
    expect(
      loadConfig({
        ...dev,
        AI_RANKING_MODEL: 'claude-opus-5-5',
        AI_PRICE_TABLE: '{"claude-opus-5-5":{"in":4,"out":20}}',
      }).aiRankingModel,
    ).toBe('claude-opus-5-5');
  });
});

// PR30: outside production, a config whose DynamoDB target is NOT local
// (DYNAMODB_ENDPOINT unset, or a host other than localhost / 127.0.0.1 /
// [::1]) is running against REAL tables - `npm run dev` live mode reads
// hosted dev's tables. There the driver defaults to anthropic and the
// ranking poll to off, so a laptop never claims a hosted-dev ranking job.
// (The refusal of fake / console there is S2.2's.)
describe('ranking config on real tables outside production (PR30)', () => {
  it('isLocalDynamoTarget: only a localhost / 127.0.0.1 / [::1] endpoint is local', () => {
    expect(isLocalDynamoTarget(undefined)).toBe(false);
    expect(isLocalDynamoTarget('')).toBe(false);
    expect(isLocalDynamoTarget('   ')).toBe(false);
    expect(isLocalDynamoTarget('http://localhost:8000')).toBe(true);
    expect(isLocalDynamoTarget(' http://LOCALHOST:8000 ')).toBe(true);
    expect(isLocalDynamoTarget('http://127.0.0.1:8000')).toBe(true);
    expect(isLocalDynamoTarget('http://[::1]:8000')).toBe(true);
    expect(isLocalDynamoTarget('https://dynamodb.us-east-1.amazonaws.com')).toBe(false);
    expect(isLocalDynamoTarget('http://dynamodb-local:8000')).toBe(false);
    expect(isLocalDynamoTarget('not a url')).toBe(false);
  });

  it('no endpoint: the driver defaults to anthropic and the ranking poll to off', () => {
    expect(loadConfig({ ...live })).toMatchObject({ rankingDriver: 'anthropic', rankingWorkerPoll: false });
    expect(loadConfig({ NODE_ENV: 'test' })).toMatchObject({ rankingDriver: 'anthropic', rankingWorkerPoll: false });
  });

  it('a non-local endpoint is real tables too', () => {
    expect(
      loadConfig({ ...live, DYNAMODB_ENDPOINT: 'https://dynamodb.us-east-1.amazonaws.com' }),
    ).toMatchObject({ rankingDriver: 'anthropic', rankingWorkerPoll: false });
  });

  it('an explicit RANKING_WORKER_POLL=on is honored there (the anthropic driver only)', () => {
    expect(loadConfig({ ...live, RANKING_WORKER_POLL: 'on' }).rankingWorkerPoll).toBe(true);
  });

  it('every other default is the same as on local tables', () => {
    const { rankingDriver: _driver, rankingWorkerPoll: _poll, ...rest } = DEFAULTS;
    expect(loadConfig({ ...live })).toMatchObject(rest);
  });
});
