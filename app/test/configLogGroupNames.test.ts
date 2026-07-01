// app/test/configLogGroupNames.test.ts
//
// Contract test: workerLogGroupName + systemLogGroupName are derived from
// appEnv and match the Terraform observability module's `/hc/<env>/<proc>`
// pattern (same source of truth as errorLogGroupName / systemStatusNaming).
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

describe('config: worker + system log group names', () => {
  it('derives workerLogGroupName + systemLogGroupName from appEnv (dev)', () => {
    const cfg = loadConfig({ TABLE_PREFIX: 'hc-dev-' } as NodeJS.ProcessEnv);
    expect(cfg.workerLogGroupName).toBe('/hc/dev/worker');
    expect(cfg.systemLogGroupName).toBe('/hc/dev/system');
  });

  it('matches the pattern for prod (not a dev-only coincidence)', () => {
    const cfg = loadConfig({ TABLE_PREFIX: 'hc-prod-' } as NodeJS.ProcessEnv);
    expect(cfg.workerLogGroupName).toBe('/hc/prod/worker');
    expect(cfg.systemLogGroupName).toBe('/hc/prod/system');
  });
});
