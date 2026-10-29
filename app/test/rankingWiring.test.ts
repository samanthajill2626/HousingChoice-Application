// The ranking job's wiring (WP1 B2a spec D7, spec 5 "Worker" and "The
// hermetic lane"). worker.ts is an entrypoint with top-level await and cannot
// be imported in a test, so its block is pinned by a source scan (the
// tenantMatchingInputsReaders precedent); so is the lane's childEnv.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createRankingJobDeps } from '../src/services/ranking/jobWiring.js';
import { createLogCapture } from './helpers/logCapture.js';

const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const session = readFileSync(new URL('../../scripts/e2e-session.mjs', import.meta.url), 'utf8');

describe('worker.ts ranking poll', () => {
  it('starts through the shared startPoll, guarded ONLY by rankingWorkerPoll, outside the extraction switch', () => {
    const extractionEnd = worker.indexOf("startPoll('extraction', (now) => runDueExtractions(now, extractionDeps));");
    const guard = worker.indexOf('if (config.rankingWorkerPoll) {');
    const start = worker.indexOf("startPoll('ranking', (now) => runDueRankings(now, rankingDeps));");
    expect(extractionEnd).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(extractionEnd);
    expect(start).toBeGreaterThan(guard);
    expect(worker.slice(guard, start)).not.toContain('aiExtractionEnabled');
    expect(worker.slice(guard, start)).toContain('createRankingJobDeps({ config, logger, events: appEvents })');
  });
});

describe('scripts/e2e-session.mjs', () => {
  it('sets the fake ranking driver and turns the worker ranking poll off in the childEnv both children inherit', () => {
    const start = session.indexOf('const childEnv = {');
    const end = session.indexOf('\n};', start);
    expect(start).toBeGreaterThan(-1);
    const block = session.slice(start, end);
    expect(block).toContain("RANKING_DRIVER: 'fake',");
    expect(block).toContain("RANKING_WORKER_POLL: 'off',");
    // PR30: the fake driver is accepted only on a LOCAL DynamoDB target.
    expect(block).toContain('DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? LOCAL_ENDPOINT,');
  });
});

describe('createRankingJobDeps', () => {
  // PR30: a LOCAL endpoint, or S2's config defaults the driver to anthropic
  // (and createRankingDriver would need a key) - local tables get console.
  const opts = (max: string) => ({
    config: loadConfig({ NODE_ENV: 'test', DYNAMODB_ENDPOINT: 'http://localhost:8000', RANKING_MAX_CONCURRENT_JOBS: max }),
    logger: createLogger({ destination: createLogCapture().stream }),
    events: { emit: () => undefined },
  });

  it('builds the driver from config and one slot set sized RANKING_MAX_CONCURRENT_JOBS, with no network at construction', () => {
    const o = opts('3');
    const deps = createRankingJobDeps(o);
    expect(deps.driver.kind).toBe('console');
    const releases = [deps.slots.tryAcquire(), deps.slots.tryAcquire(), deps.slots.tryAcquire()];
    expect(releases.every((r) => typeof r === 'function')).toBe(true);
    expect(deps.slots.tryAcquire()).toBeUndefined();
    expect(deps.config).toBe(o.config);
  });

  it('each call builds its own slots (one per process)', () => {
    const o = opts('1');
    const a = createRankingJobDeps(o);
    const b = createRankingJobDeps(o);
    a.slots.tryAcquire();
    expect(b.slots.tryAcquire()).toBeTypeOf('function');
  });
});

describe('the worker poll switch (PR30, worker side)', () => {
  it('real tables outside production: the poll is off by default, so worker.ts starts none', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).rankingWorkerPoll).toBe(false);
    expect(loadConfig({ NODE_ENV: 'development', CF_ORIGIN_SECRET: 's' }).rankingWorkerPoll).toBe(false);
  });

  it('local tables: the poll is on by default', () => {
    expect(loadConfig({ NODE_ENV: 'development', CF_ORIGIN_SECRET: 's', DYNAMODB_ENDPOINT: 'http://localhost:8000' }).rankingWorkerPoll).toBe(true);
  });
});
