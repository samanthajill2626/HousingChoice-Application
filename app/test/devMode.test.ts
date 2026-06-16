// Mode/env resolution for the local dev loop — scripts/lib/devMode.mjs.
// Pure logic only; the AWS account guard and process spawning live in
// scripts/dev.mjs and are not exercised here.
import { describe, expect, it } from 'vitest';

// Plain .mjs module outside the app workspace (typed by devMode.d.mts);
// vitest resolves it fine, tsc checks it via tsconfig.test.json.
import {
  LIVE_AWS_PROFILE,
  LIVE_TABLE_PREFIX,
  LOCAL_TABLE_PREFIX,
  resolveDevEnv,
} from '../../scripts/lib/devMode.mjs';

const LOCAL_ENDPOINT = 'http://localhost:8000';

function resolve(opts: {
  local?: boolean;
  processEnv?: Record<string, string | undefined>;
  fileEnv?: Record<string, string>;
}) {
  return resolveDevEnv({
    local: opts.local ?? false,
    processEnv: opts.processEnv ?? {},
    fileEnv: opts.fileEnv ?? {},
    localEndpoint: LOCAL_ENDPOINT,
  });
}

describe('resolveDevEnv', () => {
  it('defaults to live mode with hc-dev- tables and the housingchoice profile', () => {
    const { mode, overlay } = resolve({});
    expect(mode).toBe('live');
    expect(overlay.TABLE_PREFIX).toBe(LIVE_TABLE_PREFIX);
    expect(overlay.AWS_PROFILE).toBe(LIVE_AWS_PROFILE);
    expect(overlay.DYNAMODB_ENDPOINT).toBeUndefined();
  });

  it('--local selects hermetic mode with the local endpoint and hc-local- prefix', () => {
    const { mode, overlay } = resolve({ local: true });
    expect(mode).toBe('local');
    expect(overlay.DYNAMODB_ENDPOINT).toBe(LOCAL_ENDPOINT);
    expect(overlay.TABLE_PREFIX).toBe(LOCAL_TABLE_PREFIX);
    expect(overlay.AWS_PROFILE).toBeUndefined();
  });

  it('DYNAMODB_ENDPOINT in the environment forces hermetic mode', () => {
    const { mode, overlay } = resolve({
      processEnv: { DYNAMODB_ENDPOINT: 'http://localhost:9999' },
    });
    expect(mode).toBe('local');
    // already set in the environment — the overlay must not duplicate it
    expect(overlay.DYNAMODB_ENDPOINT).toBeUndefined();
    expect(overlay.TABLE_PREFIX).toBe(LOCAL_TABLE_PREFIX);
  });

  it('DYNAMODB_ENDPOINT in .env forces hermetic mode and rides the overlay', () => {
    const { mode, overlay } = resolve({
      fileEnv: { DYNAMODB_ENDPOINT: 'http://localhost:9999' },
    });
    expect(mode).toBe('local');
    expect(overlay.DYNAMODB_ENDPOINT).toBe('http://localhost:9999');
  });

  it('real environment variables win over .env values', () => {
    const { overlay } = resolve({
      processEnv: { LOG_LEVEL: 'info' },
      fileEnv: { LOG_LEVEL: 'debug', PORT: '8081' },
    });
    expect(overlay.LOG_LEVEL).toBeUndefined(); // env wins; not in overlay
    expect(overlay.PORT).toBe('8081'); // .env value passes through
  });

  it('.env values win over mode defaults', () => {
    const { mode, overlay } = resolve({
      fileEnv: { TABLE_PREFIX: 'hc-custom-', AWS_PROFILE: 'other-profile' },
    });
    expect(mode).toBe('live');
    expect(overlay.TABLE_PREFIX).toBe('hc-custom-');
    expect(overlay.AWS_PROFILE).toBe('other-profile');
  });

  it('refuses live mode pointed at prod tables', () => {
    expect(() => resolve({ fileEnv: { TABLE_PREFIX: 'hc-prod-' } })).toThrowError(/PROD/);
    expect(() =>
      resolve({ processEnv: { TABLE_PREFIX: 'hc-prod-' } }),
    ).toThrowError(/PROD/);
  });

  it('allows hc-prod- prefix in hermetic mode (DynamoDB Local cannot hit prod)', () => {
    const { mode } = resolve({ local: true, fileEnv: { TABLE_PREFIX: 'hc-prod-' } });
    expect(mode).toBe('local');
  });
});

describe('resolveDevEnv — DEV_AUTH_ENABLED', () => {
  it('enables the dev auth router in local mode (--local)', () => {
    const { mode, overlay } = resolve({ local: true });
    expect(mode).toBe('local');
    expect(overlay.DEV_AUTH_ENABLED).toBe('1');
  });

  it('enables the dev auth router when DYNAMODB_ENDPOINT forces local mode', () => {
    const { mode, overlay } = resolve({
      processEnv: { DYNAMODB_ENDPOINT: 'http://localhost:9999' },
    });
    expect(mode).toBe('local');
    expect(overlay.DEV_AUTH_ENABLED).toBe('1');
  });

  it('does NOT enable the dev auth router in live mode', () => {
    const { mode, overlay } = resolve({});
    expect(mode).toBe('live');
    expect(overlay.DEV_AUTH_ENABLED).toBeUndefined();
  });

  it('respects an explicit DEV_AUTH_ENABLED from the environment in local mode', () => {
    const { mode, overlay } = resolve({
      local: true,
      processEnv: { DEV_AUTH_ENABLED: '0' },
    });
    expect(mode).toBe('local');
    // env wins over the mode default — the overlay must not clobber it.
    expect(overlay.DEV_AUTH_ENABLED).toBeUndefined();
  });
});
