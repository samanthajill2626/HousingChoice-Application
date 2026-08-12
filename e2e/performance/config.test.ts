import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseRunConfig,
  toSafeRunConfig,
  type RunConfig,
  type SafeRunConfig,
} from './config.js';

const NOW = new Date('2026-08-11T16:00:00.000Z');
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const parse = (argv: string[]) =>
  parseRunConfig(argv, {
    cwd: REPO_ROOT,
    now: () => NOW,
    randomRouteOrderSeed: () => 4_242,
  });

const SELF_QA_BASE = ['hermetic', '--scale=1', '--cold-repeats=1', '--warm-repeats=1'];
const OVERRIDES = [
  '--contacts=100',
  '--units=25',
  '--placements=50',
  '--tours=50',
  '--conversations=100',
  '--messages-per-conversation=10',
  '--broadcasts=10',
  '--recipients-per-broadcast=25',
] as const;

describe('parseRunConfig', () => {
  it('resolves hermetic defaults including the exact local-login identity', () => {
    const config = parse(['hermetic']);

    expect(config).toMatchObject({
      target: 'hermetic',
      baseUrl: null,
      loginEmail: 'founder@example.com',
      baselinePath: null,
      browserChannel: 'chromium',
      headed: false,
      coldRepeats: 3,
      warmRepeats: 3,
      readyTimeoutMs: 120_000,
      sourceTimeoutMs: 120_000,
      loginTimeoutMs: 300_000,
      settleMs: 500,
      pollMs: 100,
      routeOrderSeed: 4_242,
      contractCheckpoint: false,
      selfQa: null,
      printConfig: false,
    });
    expect(config.seed).toMatchObject({
      anchor: NOW.toISOString(),
      contacts: 100,
      messagesPerConversation: 10,
      recipientsPerBroadcast: 25,
    });
  });

  it('parses every numeric control and a resolved comparison path', () => {
    const config = parse([
      'hermetic',
      '--scale',
      '2',
      '--contacts=11',
      '--units=12',
      '--placements=13',
      '--tours=14',
      '--conversations=15',
      '--messages-per-conversation=16',
      '--broadcasts=17',
      '--recipients-per-broadcast=18',
      '--cold-repeats=4',
      '--warm-repeats=5',
      '--ready-timeout-ms=6000',
      '--source-timeout-ms=7000',
      '--login-timeout-ms=8000',
      '--settle-ms=900',
      '--poll-ms=100',
      '--route-order-seed=123',
      '--baseline=fixtures/baseline.json',
      '--print-config',
    ]);

    expect(config).toMatchObject({
      coldRepeats: 4,
      warmRepeats: 5,
      readyTimeoutMs: 6_000,
      sourceTimeoutMs: 7_000,
      loginTimeoutMs: 8_000,
      settleMs: 900,
      pollMs: 100,
      routeOrderSeed: 123,
      baselinePath: resolve(REPO_ROOT, 'fixtures/baseline.json'),
      printConfig: true,
    });
    expect(config.seed).toMatchObject({
      scale: 2,
      contacts: 11,
      units: 12,
      placements: 13,
      tours: 14,
      conversations: 15,
      messagesPerConversation: 16,
      broadcasts: 17,
      recipientsPerBroadcast: 18,
    });
  });

  it.each(['narrow', 'full'] as const)('accepts locked %s self-QA configuration', (mode) => {
    const config = parse([
      ...SELF_QA_BASE,
      `--self-qa=${mode}`,
      '--route-order-seed=19',
      '--ready-timeout-ms=1000',
      '--source-timeout-ms=2000',
      '--login-timeout-ms=3000',
      '--settle-ms=200',
      '--poll-ms=100',
    ]);

    expect(config.selfQa).toBe(mode);
    expect(config.routeOrderSeed).toBe(19);
  });

  it.each(['narrow', 'full'] as const)(
    'rejects all eight explicit count or density overrides under %s self-QA',
    (mode) => {
      for (const override of OVERRIDES) {
        expect(() => parse([...SELF_QA_BASE, `--self-qa=${mode}`, override])).toThrow(
          override.split('=')[0],
        );
      }
    },
  );

  it.each([
    ['scale', [...SELF_QA_BASE.slice(0, 1), '--scale=2', ...SELF_QA_BASE.slice(2), '--self-qa=full']],
    ['cold repeats', ['hermetic', '--scale=1', '--cold-repeats=2', '--warm-repeats=1', '--self-qa=full']],
    ['warm repeats', ['hermetic', '--scale=1', '--cold-repeats=1', '--warm-repeats=2', '--self-qa=full']],
  ])('rejects self-QA with non-default locked %s', (_name, argv) => {
    expect(() => parse(argv)).toThrow('--self-qa');
  });

  it('accepts the locked contract checkpoint and rejects every scale, repeat, and override drift', () => {
    expect(parse([...SELF_QA_BASE, '--contract-checkpoint']).contractCheckpoint).toBe(true);

    const invalid = [
      ['hermetic', '--scale=2', '--cold-repeats=1', '--warm-repeats=1', '--contract-checkpoint'],
      ['hermetic', '--scale=1', '--cold-repeats=2', '--warm-repeats=1', '--contract-checkpoint'],
      ['hermetic', '--scale=1', '--cold-repeats=1', '--warm-repeats=2', '--contract-checkpoint'],
      ...OVERRIDES.map((override) => [...SELF_QA_BASE, '--contract-checkpoint', override]),
    ];
    for (const argv of invalid) expect(() => parse(argv)).toThrow('--contract-checkpoint');
  });

  it('rejects both orderings of checkpoint and self-QA before target work', () => {
    expect(() =>
      parse([...SELF_QA_BASE, '--contract-checkpoint', '--self-qa=narrow']),
    ).toThrow('--contract-checkpoint');
    expect(() =>
      parse([...SELF_QA_BASE, '--self-qa=narrow', '--contract-checkpoint']),
    ).toThrow('--contract-checkpoint');
  });

  it.each(['local', 'hosted-dev'] as const)(
    '%s forbids scale, every override, self-QA, and the checkpoint',
    (target) => {
      const base =
        target === 'local'
          ? [target, '--base-url=http://localhost:5174']
          : [target, '--base-url=https://dev.example.test', '--headed'];
      const forbidden = [
        '--scale=1',
        ...OVERRIDES,
        '--self-qa=narrow',
        '--self-qa=full',
        '--contract-checkpoint',
      ];

      for (const option of forbidden) {
        expect(() => parse([...base, option])).toThrow(option.split('=')[0]);
      }
    },
  );

  it('hermetic forbids target identity and headed/non-default browser options', () => {
    const forbidden = [
      '--base-url=https://private.example.test',
      '--login-email=private@example.test',
      '--headed',
      '--browser-channel=chrome',
    ];
    for (const option of forbidden) {
      expect(() => parse(['hermetic', option])).toThrow(option.split('=')[0]);
    }

    expect(parse(['hermetic', '--browser-channel=chromium']).browserChannel).toBe('chromium');
  });

  it.each([
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://[::1]:5174',
  ])('accepts local exact loopback port 5174: %s', (baseUrl) => {
    expect(parse(['local', `--base-url=${baseUrl}`]).baseUrl).toBe(baseUrl);
  });

  it.each([
    ['missing', ['local']],
    ['wrong port', ['local', '--base-url=http://localhost:5173']],
    ['non-loopback', ['local', '--base-url=http://example.test:5174']],
    ['https', ['local', '--base-url=https://localhost:5174']],
  ])('rejects local base URL that is %s', (_name, argv) => {
    expect(() => parse(argv)).toThrow('--base-url');
  });

  it('requires hosted HTTPS, a base URL, and headed mode', () => {
    expect(() => parse(['hosted-dev', '--headed'])).toThrow('--base-url');
    expect(() =>
      parse(['hosted-dev', '--base-url=http://dev.example.test', '--headed']),
    ).toThrow('--base-url');
    expect(() =>
      parse(['hosted-dev', '--base-url=https://dev.example.test']),
    ).toThrow('--headed');

    expect(
      parse(['hosted-dev', '--base-url=https://dev.example.test', '--headed']).target,
    ).toBe('hosted-dev');
  });

  it.each([
    '--cold-repeats=0',
    '--warm-repeats=1.5',
    '--ready-timeout-ms=-1',
    '--source-timeout-ms=0',
    '--login-timeout-ms=0',
    '--settle-ms=0',
    '--poll-ms=0',
    '--route-order-seed=0',
  ])('rejects invalid positive numeric control %s', (option) => {
    expect(() => parse(['hermetic', option])).toThrow(option.split('=')[0]);
  });

  it('requires settle-ms to be at least poll-ms', () => {
    expect(() => parse(['hermetic', '--settle-ms=99', '--poll-ms=100'])).toThrow(
      '--settle-ms',
    );
  });

  it('rejects unknown targets, options, extra positionals, duplicates, and invalid self-QA modes', () => {
    expect(() => parse([])).toThrow('target');
    expect(() => parse(['production'])).toThrow('target');
    expect(() => parse(['hermetic', '--unknown=1'])).toThrow('--unknown');
    expect(() => parse(['hermetic', 'extra'])).toThrow('positional');
    expect(() => parse(['hermetic', '--scale=1', '--scale=1'])).toThrow('--scale');
    expect(() => parse(['hermetic', '--self-qa=wide'])).toThrow('--self-qa');
  });

  it('never repeats sensitive option values in validation errors', () => {
    const sentinels = [
      ['hermetic', '--base-url=https://host-sentinel.invalid'],
      ['hermetic', '--login-email=email-sentinel@example.invalid'],
      ['hermetic', '--baseline=baseline-sentinel/private.json', '--baseline=other.json'],
    ];

    for (const argv of sentinels) {
      try {
        parse(argv);
        throw new Error('expected parse failure');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain('host-sentinel');
        expect(message).not.toContain('email-sentinel');
        expect(message).not.toContain('baseline-sentinel');
      }
    }
  });
});

describe('toSafeRunConfig', () => {
  it('constructs a fresh allowlisted hermetic object with a counts-only seed manifest', () => {
    const internal = Object.assign(parse(['hermetic', '--baseline=secret/baseline.json']), {
      credential: 'credential-sentinel',
      redirect: 'redirect-sentinel',
    }) as RunConfig & { credential: string; redirect: string };
    const safe = toSafeRunConfig(internal);
    const serialized = JSON.stringify(safe);

    expect(safe).not.toBe(internal);
    expect(safe.seed).toMatchObject({ contacts: 100, anchor: NOW.toISOString() });
    expect(Object.keys(safe).sort()).toEqual(
      [
        'browserChannel',
        'coldRepeats',
        'contractCheckpoint',
        'headed',
        'loginTimeoutMs',
        'pollMs',
        'readyTimeoutMs',
        'routeOrderSeed',
        'seed',
        'selfQa',
        'settleMs',
        'sourceTimeoutMs',
        'target',
        'warmRepeats',
      ].sort(),
    );
    expect(serialized).not.toContain('baseline.json');
    expect(serialized).not.toContain('credential-sentinel');
    expect(serialized).not.toContain('redirect-sentinel');
  });

  it.each([
    ['local', ['local', '--base-url=http://localhost:5174', '--login-email=email-sentinel@example.test']],
    ['hosted-dev', ['hosted-dev', '--base-url=https://host-sentinel.invalid', '--headed']],
  ] as const)('emits null seed and no target identity for %s', (_target, argv) => {
    const internal = parse([...argv, '--baseline=baseline-sentinel.json']);
    const serialized = JSON.stringify(toSafeRunConfig(internal));

    expect((JSON.parse(serialized) as SafeRunConfig).seed).toBeNull();
    expect(serialized).not.toContain('host-sentinel');
    expect(serialized).not.toContain('email-sentinel');
    expect(serialized).not.toContain('baseline-sentinel');
  });
});

describe('real npm argv forwarding', () => {
  it(
    'forwards --scale through npm.cmd and prints one side-effect-free JSON value',
    async () => {
      const npmExecutable =
        process.platform === 'win32' ? resolve(dirname(process.execPath), 'npm.cmd') : 'npm';
      const executable = process.platform === 'win32' ? process.env.ComSpec : npmExecutable;
      if (!executable) throw new Error('missing Windows command interpreter');
      const npmArgs = [
        'run',
        '--silent',
        'perf:pages',
        '--',
        'hermetic',
        '--scale=7',
        '--print-config',
      ];
      const childArgs =
        process.platform === 'win32'
          ? ['/d', '/s', '/c', `""${npmExecutable}" ${npmArgs.join(' ')}"`]
          : npmArgs;
      const artifactRoot = resolve(REPO_ROOT, 'e2e/.artifacts/performance');
      const sessionPid = resolve(REPO_ROOT, 'e2e/.artifacts/session.pid');
      const beforeArtifacts = existsSync(artifactRoot);
      const beforePid = existsSync(sessionPid);
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolveResult, reject) => {
          const child = spawn(
            executable,
            childArgs,
            {
              cwd: REPO_ROOT,
              shell: false,
              windowsHide: true,
              windowsVerbatimArguments: process.platform === 'win32',
            },
          );
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error('argv child timeout'));
          }, 60_000);
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.on('data', (chunk: string) => {
            if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
          });
          child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolveResult({ code, stdout, stderr });
          });
        },
      );

      expect(result.code).toBe(0);
      const parseStdoutOnly = (stdout: string, _boundedStderr: string): SafeRunConfig =>
        JSON.parse(stdout.trim()) as SafeRunConfig;
      const printed = parseStdoutOnly(result.stdout, `${result.stderr}synthetic warning`);
      expect(result.stdout.trim().split(/\r?\n/u)).toHaveLength(1);
      expect(printed.seed?.contacts).toBe(700);
      expect(existsSync(artifactRoot)).toBe(beforeArtifacts);
      expect(existsSync(sessionPid)).toBe(beforePid);
    },
    65_000,
  );
});
