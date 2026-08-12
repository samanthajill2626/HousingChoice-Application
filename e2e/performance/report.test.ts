import { watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SafeRunConfig } from './config.js';
import {
  createPerformanceRunId,
  evaluateContractCheckpoint,
  writePerformanceReport,
} from './report.js';
import {
  ROUTES,
  expectedBlockedWrites,
  expectedGets,
  type RouteContractBranch,
} from './routes.js';
import type {
  RequestEvidence,
  ResourceClass,
  SampleResult,
  TargetMetadata,
} from './types.js';

const fsFaults = vi.hoisted(() => ({
  stagedSensitiveValue: null as string | null,
  failStagingReadNumber: null as number | null,
  stagingReadCount: 0,
  stagingRemoveFailures: 0,
  failStagingBlankWrites: false,
  failStagingRename: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const actualReadFile = actual.readFile as (...args: unknown[]) => Promise<unknown>;
  const actualRm = actual.rm as (...args: unknown[]) => Promise<void>;
  const actualWriteFile = actual.writeFile as (...args: unknown[]) => Promise<void>;
  const actualRename = actual.rename as (...args: unknown[]) => Promise<void>;
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      const path = String(args[0]);
      if (fsFaults.stagedSensitiveValue !== null && path.includes('-staging')) {
        const value = fsFaults.stagedSensitiveValue;
        fsFaults.stagedSensitiveValue = null;
        await actual.writeFile(path, value, 'utf8');
      }
      if (path.includes('-staging')) {
        fsFaults.stagingReadCount += 1;
        if (fsFaults.failStagingReadNumber === fsFaults.stagingReadCount) {
          const error = new Error('locked staging read') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
      }
      return await actualReadFile(...args);
    },
    rm: async (...args: unknown[]) => {
      const path = String(args[0]);
      if (fsFaults.stagingRemoveFailures > 0 && path.endsWith('-staging')) {
        fsFaults.stagingRemoveFailures -= 1;
        const error = new Error('transient staging lock') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      await actualRm(...args);
    },
    writeFile: async (...args: unknown[]) => {
      const path = String(args[0]);
      if (fsFaults.failStagingBlankWrites && path.includes('-staging') && args[1] === '') {
        const error = new Error('locked staging content') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      await actualWriteFile(...args);
    },
    rename: async (...args: unknown[]) => {
      if (fsFaults.failStagingRename && String(args[0]).endsWith('-staging')) {
        const error = new Error('locked staging rename') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      await actualRename(...args);
    },
  };
});

const createdRoots: string[] = [];

afterEach(async () => {
  fsFaults.stagedSensitiveValue = null;
  fsFaults.failStagingReadNumber = null;
  fsFaults.stagingReadCount = 0;
  fsFaults.stagingRemoveFailures = 0;
  fsFaults.failStagingBlankWrites = false;
  fsFaults.failStagingRename = false;
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hc-performance-report-'));
  createdRoots.push(root);
  return root;
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat().sort();
}

function resourceCounts(api = 3, script = 2): Record<ResourceClass, number> {
  return {
    document: 1,
    script,
    style: 1,
    font: 0,
    image: 0,
    api,
    other: 0,
  };
}

const CONFIG: SafeRunConfig = {
  target: 'hermetic',
  browserChannel: 'chromium',
  headed: false,
  coldRepeats: 3,
  warmRepeats: 3,
  readyTimeoutMs: 120_000,
  sourceTimeoutMs: 120_000,
  loginTimeoutMs: 300_000,
  settleMs: 500,
  pollMs: 100,
  routeOrderSeed: 42,
  contractCheckpoint: false,
  selfQa: null,
  seed: {
    anchor: '2026-08-12T12:00:00.000Z',
    scale: 1,
    contacts: 100,
    units: 25,
    placements: 50,
    tours: 50,
    conversations: 100,
    messagesPerConversation: 10,
    broadcasts: 10,
    recipientsPerBroadcast: 25,
    messageCount: 1_000,
    requestedRecipientCount: 250,
    resolvedRecipientsPerBroadcast: 25,
    resolvedRecipientCount: 250,
    requestedRelayGroupCount: 20,
    relayGroupCount: 20,
    clippedRelayGroupCount: 0,
    fixedUnmatchedEmailCount: 4,
    physicalItemCount: 1_339,
    totalItemCount: 1_589,
    fallbacks: { tenant: 'lean_tenant', landlord: 'lean_landlord', unit: 'lean_unit' },
  },
};

const TARGET: TargetMetadata = {
  target: 'hermetic',
  proof: 'hermetic_lane',
  profilerCommit: 'abcdef1',
  targetAppCommit: '1234567',
  targetVersionStatus: 'verified',
};

function sample(
  routeKey: string,
  mode: 'cold' | 'warm',
  repeat: number,
  overrides: Partial<SampleResult> = {},
): SampleResult {
  return {
    routeKey,
    mode,
    repeat,
    status: 'ok',
    readyMs: routeKey === '/contacts' ? 900 : 100,
    navigation: { ttfbMs: 20, domContentLoadedMs: 70, loadMs: 80 },
    paint: { fcpMs: 40, lcpMs: 60 },
    longTasks: { totalMs: 12, maxMs: 8, count: 2 },
    domElements: 120,
    apiRequestCount: 3,
    apiTransferBytes: 600,
    resourceRequestCount: 7,
    resourceTransferBytes: 900,
    resourceCountsByClass: resourceCounts(),
    backgroundRequestCount: 2,
    backgroundTransferBytes: 44,
    blockedWrites: [{
      method: 'POST',
      endpointTemplate: '/api/inbox/:contactId/read',
      phase: 'destination_mount',
    }],
    consoleCategories: { client_truncated: 1 },
    clientTruncated: true,
    terminalState: 'populated',
    reason: null,
    ...overrides,
  };
}

function request(routeKey: string, mode: 'cold' | 'warm', repeat: number): RequestEvidence {
  return {
    routeKey,
    mode,
    repeat,
    method: 'GET',
    resourceClass: 'api',
    originClass: 'first_party',
    endpointTemplate: '/api/contacts',
    queryKeys: ['limit', 'type'],
    startOffsetMs: 1,
    durationMs: 12,
    ttfbMs: 5,
    status: 200,
    transferBytes: 321,
    outcome: 'finished',
    requestRole: repeat === 0 ? 'required' : 'background_refresh',
    unmatchedApi: false,
  };
}

function reportInput(outputRoot: string, runId: string) {
  const samples = [
    sample('/contacts', 'cold', 0),
    sample('/inbox', 'cold', 0, { readyMs: 100, clientTruncated: false }),
    sample('/contacts', 'warm', 0, { readyMs: 400 }),
    sample('/inbox', 'warm', 0, { readyMs: 50, clientTruncated: false }),
    sample('/settings/notifications', 'warm', 0, {
      status: 'skipped_no_fixture',
      reason: 'fixture_absent',
      readyMs: null,
      terminalState: 'unknown',
    }),
  ];
  return {
    outputRoot,
    runId,
    config: CONFIG,
    target: TARGET,
    samples,
    requests: [request('/contacts', 'cold', 0), request('/contacts', 'warm', 1)],
    routeOrders: [
      { mode: 'cold' as const, repeat: 0, routeKeys: ['/contacts', '/inbox'] },
      { mode: 'warm' as const, repeat: 0, routeKeys: ['/inbox', '/contacts', '/settings/notifications'] },
    ],
    browser: { version: '140.0.7339.12', viewport: { width: 1280, height: 720 } },
    warmup: { performed: true, routeKey: '/' },
    relayDomCheck: { expectedCount: 20, renderedCount: 20, shortfall: false },
  };
}

describe('createPerformanceRunId', () => {
  it('uses a compact UTC timestamp and short random hexadecimal suffix', () => {
    expect(createPerformanceRunId(
      new Date('2026-08-12T12:34:56.789Z'),
      Buffer.from([0xab, 0xcd, 0x12, 0x34]),
    )).toBe('20260812T123456789Z-abcd1234');
  });
});

describe('writePerformanceReport', () => {
  it('evaluates every checkpoint mismatch class while preserving absent conditionals', () => {
    const route = ROUTES.find((candidate) => candidate.key === '/contacts/tenants')!;
    const branch = { kind: 'none' } as const;
    const required = expectedGets(route, 'warm', branch).find((entry) => entry.requirement === 'required')!;
    const conditional = expectedGets(route, 'warm', branch).find((entry) => entry.requirement === 'conditional')!;
    const baseSample = sample(route.key, 'warm', 0, { blockedWrites: [], terminalState: 'populated' });
    const baseRequest: RequestEvidence = {
      ...request(route.key, 'warm', 0),
      endpointTemplate: required.endpointTemplate,
      queryKeys: [...required.queryKeys],
      requestRole: 'required',
      unmatchedApi: false,
    };
    const evaluate = (overrides: {
      sample?: SampleResult;
      requests?: RequestEvidence[];
      branches?: Array<{ routeKey: string; mode: 'cold' | 'warm'; repeat: number; branch: RouteContractBranch }>;
    } = {}) => evaluateContractCheckpoint({
      routes: [route],
      samples: [overrides.sample ?? baseSample],
      requests: overrides.requests ?? [baseRequest],
      branches: overrides.branches ?? [{ routeKey: route.key, mode: 'warm', repeat: 0, branch }],
    });

    expect(evaluate().mismatchCodes).toEqual([]);
    expect(evaluate({ requests: [baseRequest, {
      ...baseRequest,
      endpointTemplate: conditional.endpointTemplate,
      queryKeys: [...conditional.queryKeys],
    }] }).mismatchCodes).toEqual([]);
    expect(evaluate({ requests: [] }).mismatchCodes).toContain('missing_required_endpoint');
    expect(evaluate({ requests: [{ ...baseRequest, endpointTemplate: '/api/settings', queryKeys: [] }] }).mismatchCodes)
      .toEqual(expect.arrayContaining(['missing_required_endpoint', 'unexpected_endpoint']));
    expect(evaluate({ requests: [{ ...baseRequest, unmatchedApi: true }] }).mismatchCodes).toContain('unmatched_api');
    expect(evaluate({ requests: [{ ...baseRequest, requestRole: 'background_refresh' }] }).mismatchCodes)
      .toContain('undeclared_background');
    expect(evaluate({ sample: { ...baseSample, terminalState: 'unknown' } }).mismatchCodes)
      .toContain('unresolved_terminal');
    expect(evaluate({ sample: { ...baseSample, blockedWrites: [{
      method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount',
    }] } }).mismatchCodes).toContain('wrong_blocked_write_tuple');
    expect(evaluate({ branches: [] }).mismatchCodes).toContain('unresolved_branch');
    expect(evaluate({ sample: { ...baseSample, status: 'timeout', reason: 'ready_timeout' } }).mismatchCodes)
      .toContain('sample_failure');
  });

  it('does not mutate or auto-edit route contracts while building observations', () => {
    const before = JSON.stringify(ROUTES);
    evaluateContractCheckpoint({ routes: ROUTES.slice(0, 1), samples: [], requests: [], branches: [] });
    expect(JSON.stringify(ROUTES)).toBe(before);
  });

  it('requires the exact guarded automatic-write set and rejects tuples outside it', () => {
    const route = ROUTES.find((candidate) => candidate.key === '/conversations/:conversationId')!;
    const branch = { kind: 'none' } as const;
    const base = sample(route.key, 'warm', 0, { blockedWrites: [], terminalState: 'populated' });
    const declared = expectedGets(route, 'warm', branch).filter((entry) => entry.requirement === 'required');
    const requests = declared.map((entry) => ({
      ...request(route.key, 'warm', 0),
      endpointTemplate: entry.endpointTemplate,
      queryKeys: [...entry.queryKeys],
    }));
    const evaluate = (value: SampleResult) => evaluateContractCheckpoint({
      routes: [route], samples: [value], requests,
      branches: [{ routeKey: route.key, mode: 'warm', repeat: 0, branch }],
    });

    expect(evaluate(base).mismatchCodes).toContain('missing_blocked_write');
    expect(evaluate({ ...base, blockedWrites: [{
      method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount',
    }] }).mismatchCodes).toContain('wrong_blocked_write_tuple');
  });

  it('finalizes a sanitized checkpoint mismatch artifact before returning nonzero', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-c0ffee00');
    input.config = { ...input.config, contractCheckpoint: true };
    input.samples = [sample('/contacts/tenants', 'warm', 0, {
      blockedWrites: [], terminalState: 'unknown', status: 'timeout', reason: 'ready_timeout',
    })];
    input.requests = [{
      ...request('/contacts/tenants', 'warm', 0),
      endpointTemplate: '/api/settings',
      queryKeys: [],
      unmatchedApi: true,
    }];
    Object.assign(input, {
      checkpointBranches: [{
        routeKey: '/contacts/tenants', mode: 'warm', repeat: 0, branch: { kind: 'none' },
      }],
    });
    const secret = 'private.person@example.com';
    Object.assign(input.samples[0] as object, { rawUrl: secret, caughtError: new Error(secret) });

    const result = await writePerformanceReport(input);

    expect(result).toMatchObject({ status: 'checkpoint_mismatch', exitCode: 1 });
    expect(result.files).toContain('contract-observations.json');
    const text = await readFile(join(outputRoot, input.runId, 'contract-observations.json'), 'utf8');
    const artifact = JSON.parse(text);
    expect(artifact.status).toBe('mismatch');
    expect(artifact.mismatchCodes).toEqual(expect.arrayContaining([
      'missing_sample', 'sample_failure', 'unmatched_api', 'unexpected_endpoint',
      'unresolved_terminal',
    ]));
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/https?:\/\//u);
    expect(JSON.stringify(artifact.observations[0])).not.toContain('rawUrl');
  });

  it('writes only the exact current-run artifacts with allowlisted schema and ranked Markdown', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-abcd1234');
    const secret = 'private.person@example.com';
    Object.assign(input.config as object, { baseUrl: `https://${secret}`, loginEmail: secret });
    Object.assign(input.target as object, { rawHost: secret });
    Object.assign(input.samples[0] as object, { rawRequests: [{ url: secret }], caughtError: new Error(secret) });
    Object.assign(input.requests[0] as object, { rawUrl: `https://${secret}`, headers: { authorization: secret } });
    Object.assign(input.browser as object, { executablePath: secret });
    Object.assign(input.routeOrders[0] as object, { rawRouteIds: [secret] });
    Object.assign(input.warmup as object, { rawUrl: secret });
    Object.assign(input.relayDomCheck as object, { rawRows: [secret] });

    const result = await writePerformanceReport(input);

    expect(result).toEqual({
      status: 'written',
      exitCode: 0,
      runId: input.runId,
      directoryName: input.runId,
      files: ['report.md', 'requests.jsonl', 'summary.json'],
    });
    const runDirectory = join(outputRoot, input.runId);
    expect((await readdir(runDirectory)).sort()).toEqual(result.files);
    const summaryText = await readFile(join(runDirectory, 'summary.json'), 'utf8');
    const summary = JSON.parse(summaryText) as Record<string, any>;
    const requestsText = await readFile(join(runDirectory, 'requests.jsonl'), 'utf8');
    const report = await readFile(join(runDirectory, 'report.md'), 'utf8');

    expect(summary.schemaVersion).toBe(1);
    expect(Object.keys(summary).sort()).toEqual([
      'aggregates', 'artifacts', 'browser', 'comparison', 'config', 'environment',
      'interceptionScopeVersion', 'manifest', 'rankings', 'relayDomCheck', 'revisions',
      'routeOrders', 'run', 'runtime', 'samples', 'schemaVersion', 'target', 'warmup', 'warnings',
    ].sort());
    expect(summary.interceptionScopeVersion).toBe(2);
    expect(summary.config.target).toBe('hermetic');
    expect(summary.config.baseUrl).toBeUndefined();
    expect(summary.target.rawHost).toBeUndefined();
    expect(summary.revisions).toEqual({ profilerCommit: 'abcdef1', targetAppCommit: '1234567' });
    expect(summary.browser).toEqual({
      name: 'chromium',
      channel: 'chromium',
      version: '140.0.7339.12',
      major: 140,
      httpCache: 'preserved',
      viewport: { width: 1280, height: 720 },
    });
    expect(summary.runtime.node).toMatch(/^\d+\.\d+\.\d+/u);
    expect(summary.runtime.os).toMatch(/^(?:aix|darwin|freebsd|linux|openbsd|sunos|win32)\/(?:arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64)$/u);
    expect(summary.samples[0].rawRequests).toBeUndefined();
    expect(summary.requests).toBeUndefined();
    expect(summary.aggregates[0].metrics.resourceCountsByClass.api).toBeDefined();
    expect(summary.aggregates[0].noise.backgroundRequestCount).toBeDefined();
    expect(summary.routeOrders).toEqual([
      { mode: 'cold', repeat: 0, routeKeys: ['/contacts', '/inbox'] },
      { mode: 'warm', repeat: 0, routeKeys: ['/inbox', '/contacts', '/settings/notifications'] },
    ]);
    expect(summary.manifest.contacts).toBe(100);

    const requestLines = requestsText.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(requestLines).toHaveLength(2);
    expect(Object.keys(requestLines[0]).sort()).toEqual([
      'durationMs', 'endpointTemplate', 'method', 'mode', 'originClass', 'outcome',
      'queryKeys', 'repeat', 'requestRole', 'resourceClass', 'routeKey', 'startOffsetMs',
      'status', 'transferBytes', 'ttfbMs', 'unmatchedApi',
    ].sort());
    expect(requestLines[0]).toMatchObject({ outcome: 'finished', requestRole: 'required' });
    expect(requestLines[1]).toMatchObject({ outcome: 'finished', requestRole: 'background_refresh' });
    expect(requestLines[0].rawUrl).toBeUndefined();

    expect(report).toContain('## Cold worst offenders');
    expect(report.indexOf('| /contacts | 900')).toBeLessThan(report.indexOf('| /inbox | 100'));
    expect(report).toContain('## Warm worst offenders');
    expect(report).toContain('## Secondary rankings');
    expect(report).toContain('client_truncated');
    expect(report).toContain('surface_scale_bearing');
    expect(report).toContain('load_scale_bearing');
    expect(report).toContain('skipped_no_fixture');
    expect(report).toContain('/api/inbox/:contactId/read');
    expect(report).toContain('background_refresh');
    expect(report).toContain('Resource request classes');
    expect(report).toContain('report.md');
    expect(report).toContain('summary.json');
    expect(report).toContain('requests.jsonl');
    expect((summaryText + requestsText + report).includes(secret)).toBe(false);
  });

  it('adds comparison files only when a valid baseline is supplied', async () => {
    const outputRoot = await artifactRoot();
    const baselineInput = reportInput(outputRoot, '20260812T123456789Z-aabbccdd');
    await writePerformanceReport(baselineInput);
    const baselineJson = await readFile(join(outputRoot, baselineInput.runId, 'summary.json'), 'utf8');
    const currentInput = {
      ...reportInput(outputRoot, '20260812T123456790Z-eeff0011'),
      baselineJson,
    };
    currentInput.samples[0] = sample('/contacts', 'cold', 0, { readyMs: 1_000 });

    const result = await writePerformanceReport(currentInput);

    expect(result.status).toBe('written');
    expect(result.files).toEqual([
      'comparison.json', 'comparison.md', 'report.md', 'requests.jsonl', 'summary.json',
    ]);
    const comparison = JSON.parse(await readFile(join(outputRoot, currentInput.runId, 'comparison.json'), 'utf8'));
    expect(comparison.revisions.current).toEqual({
      profilerCommit: 'abcdef1',
      targetAppCommit: '1234567',
    });
    expect(comparison.matched[0].metrics.readyMs.absolute).toBe(100);
    expect(await readFile(join(outputRoot, currentInput.runId, 'comparison.md'), 'utf8'))
      .toContain('Target app revision changed: no');
  });

  it('replaces unsafe route keys before they reach any artifact', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456790Z-a1b2c3d4');
    input.routeOrders = [{
      mode: 'cold', repeat: 0, routeKeys: ['/a|b', '/contacts/perf-contact-00001'],
    }];

    const result = await writePerformanceReport(input);

    expect(result.status).toBe('written');
    const summaryText = await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8');
    expect(summaryText).not.toContain('/a|b');
    expect(summaryText).not.toContain('perf-contact-00001');
    expect(JSON.parse(summaryText).routeOrders[0].routeKeys).toEqual(['invalid_route', 'invalid_route']);
  });

  it('rejects structurally invalid baseline aggregate entries before comparison publication', async () => {
    const outputRoot = await artifactRoot();
    const baselineInput = reportInput(outputRoot, '20260812T123456790Z-b1c2d3e4');
    await writePerformanceReport(baselineInput);
    const baseline = JSON.parse(await readFile(join(outputRoot, baselineInput.runId, 'summary.json'), 'utf8'));
    baseline.aggregates[0].routeKey = '/bad|key';
    baseline.aggregates[0].mode = 'not-a-mode';
    const currentInput = {
      ...reportInput(outputRoot, '20260812T123456790Z-c1d2e3f4'),
      baselineJson: JSON.stringify(baseline),
    };

    const result = await writePerformanceReport(currentInput);

    expect(result).toMatchObject({ status: 'comparison_failure', exitCode: 1, reason: 'comparison_failed' });
    expect(result.files).not.toContain('comparison.json');
  });

  it('keeps the current report and returns a nonzero comparison failure for invalid baseline JSON', async () => {
    const outputRoot = await artifactRoot();
    const input = {
      ...reportInput(outputRoot, '20260812T123456789Z-01020304'),
      baselineJson: '{"secret":"private.person@example.com"}',
    };

    const result = await writePerformanceReport(input);

    expect(result).toEqual({
      status: 'comparison_failure',
      exitCode: 1,
      runId: input.runId,
      directoryName: input.runId,
      files: ['report.md', 'requests.jsonl', 'summary.json'],
      reason: 'comparison_failed',
    });
    const summary = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    expect(summary.comparison).toEqual({ status: 'failed', reason: 'comparison_failed' });
    expect(await readFile(join(outputRoot, input.runId, 'report.md'), 'utf8'))
      .toContain('comparison_failed');
    expect(JSON.stringify(summary).includes('private.person')).toBe(false);
  });

  it('writes a partial sanitized summary and report with a closed fatal reason', async () => {
    const outputRoot = await artifactRoot();
    const input = {
      ...reportInput(outputRoot, '20260812T123456789Z-11112222'),
      partialReason: 'browser_failure' as const,
    };

    const result = await writePerformanceReport(input);

    expect(result.status).toBe('partial');
    expect(result.exitCode).toBe(1);
    const summary = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    expect(summary.run).toEqual({ status: 'partial', reason: 'browser_failure' });
    expect(await readFile(join(outputRoot, input.runId, 'report.md'), 'utf8'))
      .toContain('Partial run reason: `browser_failure`');
  });

  it('preflights sensitive artifact strings before creating a staging directory or writing their bytes', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-33334444');
    const sensitiveValue = 'private.person@example.com';
    input.config = { ...input.config, target: sensitiveValue as never };
    const changedPaths: string[] = [];
    const watcher = watch(outputRoot, { persistent: false });
    watcher.on('change', (_eventType, fileName) => changedPaths.push(String(fileName)));

    const result = await writePerformanceReport(input);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    watcher.close();

    expect(result).toEqual({
      status: 'privacy_failure',
      exitCode: 1,
      runId: input.runId,
      directoryName: `${input.runId}-quarantined`,
      files: ['report.md', 'requests.jsonl', 'summary.json'],
      reason: 'privacy_scan_failed',
      reasonCategories: ['email_address'],
    });
    await expect(readdir(join(outputRoot, input.runId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(changedPaths).not.toContain(`${input.runId}-staging`);
    await expect(readdir(join(outputRoot, `${input.runId}-staging`))).rejects.toMatchObject({ code: 'ENOENT' });
    const quarantineDirectory = join(outputRoot, `${input.runId}-quarantined`);
    const retainedTexts = await Promise.all((await filesBelow(outputRoot)).map((path) => readFile(path, 'utf8')));
    expect(retainedTexts.some((text) => text.includes(sensitiveValue))).toBe(false);
    expect((await readdir(quarantineDirectory)).sort()).toEqual(['quarantine.json']);
    const manifest = JSON.parse(await readFile(join(quarantineDirectory, 'quarantine.json'), 'utf8'));
    expect(manifest).toEqual({
      runId: input.runId,
      status: 'privacy_failure',
      reason: 'privacy_scan_failed',
      files: result.files,
      reasonCategories: ['email_address'],
    });
    expect(JSON.stringify(result).includes('private.person')).toBe(false);
  });

  it('scrubs post-write private bytes before retrying a transient staging removal failure', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-77778888');
    const sensitiveValue = 'post.write.private@example.com';
    fsFaults.stagedSensitiveValue = sensitiveValue;
    fsFaults.stagingRemoveFailures = 1;

    const result = await writePerformanceReport(input);

    expect(result).toMatchObject({
      status: 'privacy_failure',
      directoryName: `${input.runId}-quarantined`,
      reasonCategories: ['email_address'],
    });
    await expect(readdir(join(outputRoot, `${input.runId}-staging`)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    const retainedTexts = await Promise.all((await filesBelow(outputRoot)).map((path) => readFile(path, 'utf8')));
    expect(retainedTexts.some((text) => text.includes(sensitiveValue))).toBe(false);
    expect(await readdir(join(outputRoot, `${input.runId}-quarantined`))).toEqual(['quarantine.json']);
  });

  it('retains only verified-empty staging files when all directory removal attempts are exhausted', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-99990000');
    const sensitiveValue = 'locked.post.write@example.com';
    fsFaults.stagedSensitiveValue = sensitiveValue;
    fsFaults.stagingRemoveFailures = 100;
    fsFaults.failStagingBlankWrites = true;

    const result = await writePerformanceReport(input);

    expect(result).toMatchObject({
      status: 'privacy_failure',
      directoryName: `${input.runId}-quarantined`,
      reasonCategories: ['email_address'],
    });
    const stagingDirectory = join(outputRoot, `${input.runId}-staging`);
    const stagingFiles = await readdir(stagingDirectory);
    expect(stagingFiles.sort()).toEqual(['report.md', 'requests.jsonl', 'summary.json']);
    const stagingTexts = await Promise.all(stagingFiles.map((fileName) => (
      readFile(join(stagingDirectory, fileName), 'utf8')
    )));
    expect(stagingTexts).toEqual(['', '', '']);
    const retainedTexts = await Promise.all((await filesBelow(outputRoot)).map((path) => readFile(path, 'utf8')));
    expect(retainedTexts.some((text) => text.includes(sensitiveValue))).toBe(false);
    expect(await readdir(join(outputRoot, `${input.runId}-quarantined`))).toEqual(['quarantine.json']);
  });

  it('scrubs owned staged handles when the exact-byte scan fails after a private mutation', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-aaaabbbb');
    const sensitiveValue = 'unreadable.post.write@example.com';
    fsFaults.stagedSensitiveValue = sensitiveValue;
    fsFaults.failStagingReadNumber = 2;
    fsFaults.stagingRemoveFailures = 100;
    fsFaults.failStagingBlankWrites = true;

    await expect(writePerformanceReport(input)).rejects.toThrowError('artifact_scan_failed');

    const stagingDirectory = join(outputRoot, `${input.runId}-staging`);
    const stagingFiles = await readdir(stagingDirectory);
    expect(stagingFiles.sort()).toEqual(['report.md', 'requests.jsonl', 'summary.json']);
    const stagingTexts = await Promise.all(stagingFiles.map((fileName) => (
      readFile(join(stagingDirectory, fileName), 'utf8')
    )));
    expect(stagingTexts).toEqual(['', '', '']);
    const retainedTexts = await Promise.all((await filesBelow(outputRoot)).map((path) => readFile(path, 'utf8')));
    expect(retainedTexts.some((text) => text.includes(sensitiveValue))).toBe(false);
  });

  it('reopens and scrubs every known staging file when publication rename and removal fail', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-ccccdddd');
    fsFaults.failStagingRename = true;
    fsFaults.stagingRemoveFailures = 100;
    fsFaults.failStagingBlankWrites = true;

    await expect(writePerformanceReport(input)).rejects.toThrowError('artifact_publish_failed');

    const stagingDirectory = join(outputRoot, `${input.runId}-staging`);
    const stagingFiles = await readdir(stagingDirectory);
    expect(stagingFiles.sort()).toEqual(['report.md', 'requests.jsonl', 'summary.json']);
    const stagingTexts = await Promise.all(stagingFiles.map((fileName) => (
      readFile(join(stagingDirectory, fileName), 'utf8')
    )));
    expect(stagingTexts).toEqual(['', '', '']);
    await expect(readdir(join(outputRoot, input.runId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to overwrite an extant final run directory', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-55556666');
    await mkdir(join(outputRoot, input.runId));

    await expect(writePerformanceReport(input)).rejects.toThrowError('run_directory_exists');
    expect(await readdir(join(outputRoot, input.runId))).toEqual([]);
  });
});
