import { watch } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolvePerformanceSeedConfig } from '../../app/src/lib/seed/performance.js';
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
  closeStagingHandlesOnSensitiveMutation: false,
  stagingHandles: [] as Array<{ close(): Promise<void> }>,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const actualReadFile = actual.readFile as (...args: unknown[]) => Promise<unknown>;
  const actualRm = actual.rm as (...args: unknown[]) => Promise<void>;
  const actualWriteFile = actual.writeFile as (...args: unknown[]) => Promise<void>;
  const actualRename = actual.rename as (...args: unknown[]) => Promise<void>;
  const actualOpen = actual.open as (...args: unknown[]) => Promise<import('node:fs/promises').FileHandle>;
  return {
    ...actual,
    open: async (...args: unknown[]) => {
      const handle = await actualOpen(...args);
      if (String(args[0]).includes('-staging')) fsFaults.stagingHandles.push(handle);
      return handle;
    },
    readFile: async (...args: unknown[]) => {
      const path = String(args[0]);
      if (fsFaults.stagedSensitiveValue !== null && path.includes('-staging')) {
        const value = fsFaults.stagedSensitiveValue;
        fsFaults.stagedSensitiveValue = null;
        await actual.writeFile(path, value, 'utf8');
        if (fsFaults.closeStagingHandlesOnSensitiveMutation) {
          await Promise.allSettled(fsFaults.stagingHandles.map((handle) => handle.close()));
        }
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

vi.mock('./routes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./routes.js')>();
  const inbox = actual.ROUTES.find((route) => route.surfaceId === 'inbox-all')!;
  return {
    ...actual,
    ROUTES: Object.freeze([
      ...actual.ROUTES,
      { ...inbox, surfaceId: 'inbox-extra-all' },
      { ...inbox, surfaceId: 'inbox-extra-unread' },
    ]),
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
  fsFaults.closeStagingHandlesOnSensitiveMutation = false;
  fsFaults.stagingHandles = [];
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
  seed: resolvePerformanceSeedConfig({}, '2026-08-12T12:00:00.000Z'),
};

const TARGET: TargetMetadata = {
  target: 'hermetic',
  proof: 'hermetic_lane',
  profilerCommit: 'abcdef1',
  targetAppCommit: '1234567',
  targetVersionStatus: 'verified',
};

function sample(
  surfaceId: string,
  mode: 'cold' | 'warm',
  repeat: number,
  overrides: Partial<SampleResult> = {},
): SampleResult {
  return {
    surfaceId,
    mode,
    repeat,
    status: 'ok',
    readyMs: surfaceId === '/contacts' ? 900 : 100,
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
    surfaceEvidence: overrides.surfaceEvidence ?? null,
  };
}

function request(surfaceId: string, mode: 'cold' | 'warm', repeat: number): RequestEvidence {
  return {
    surfaceId,
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
    sample('inbox-all', 'cold', 0, {
      readyMs: 100,
      clientTruncated: false,
      surfaceEvidence: {
        kind: 'inbox', filter: 'all', renderedRowCount: 10, groupsTruncated: false, initialInboxPageRequestCount: 1,
      },
    }),
    sample('/contacts', 'warm', 0, {
      readyMs: 400,
      surfaceEvidence: { kind: 'conversation_detail', initialRenderedMessageCount: null },
    }),
    sample('inbox-all', 'warm', 0, { readyMs: 50, clientTruncated: false }),
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
      { mode: 'cold' as const, repeat: 0, surfaceIds: ['/contacts', 'inbox-all'] },
      { mode: 'warm' as const, repeat: 0, surfaceIds: ['inbox-all', '/contacts', '/settings/notifications'] },
    ],
    browser: { version: '140.0.7339.12', viewport: { width: 1280, height: 720 } },
    warmup: { performed: true, surfaceId: '/' },
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
  it('writes closed v2 comparison metadata without a seed anchor or requested inputs', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-c0dec0de');

    await expect(writePerformanceReport(input)).resolves.toMatchObject({ status: 'written', exitCode: 0 });

    const summary = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ schemaVersion: 2, registryVersion: 2, workloadVersion: 2 });
    expect(summary.environment.comparisonWorkload).toMatchObject({
      contacts: 100,
      activeContacts: 85,
      recipientPoolSize: 81,
      recipientPoolSource: 'generated_tenants',
      longConversationFixturePresent: true,
      largeBroadcastFixturePresent: true,
    });
    expect(Object.keys(summary.environment.comparisonWorkload).sort()).toEqual([
      'activeContacts', 'broadcasts', 'contacts', 'conversations', 'largeBroadcastFixturePresent',
      'longConversationFixturePresent', 'messagesPerConversation', 'nativeGroupMemberSlotCount',
      'nativeGroups', 'placements', 'recipientPoolSize', 'recipientPoolSource',
      'resolvedLargeBroadcastRecipients', 'resolvedLongConversationMessages',
      'resolvedRecipientsPerBroadcast', 'totalConversations', 'totalMessageCount',
      'totalRecipientCount', 'tours', 'units', 'workloadModelVersion',
    ]);
    expect(JSON.stringify(summary.environment.comparisonWorkload)).not.toContain('anchor');
    expect(JSON.stringify(summary.environment.comparisonWorkload)).not.toContain('requested');
  });

  it('sanitizes every closed comparison-workload pool and fixture field before persistence', async () => {
    const outputRoot = await artifactRoot();
    const base = reportInput(outputRoot, '20260812T123456789Z-01234567');
    const input = {
      ...base,
      config: {
        ...base.config,
        seed: {
          ...base.config.seed!,
          activeContactCount: 'raw-contact-id',
          recipientPoolSize: -1,
          recipientPoolSource: 'private.person@example.com',
          longConversationFixturePresent: 'yes',
          largeBroadcastFixturePresent: 'yes',
        } as never,
      },
    };

    await writePerformanceReport(input);

    const summary = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    expect(summary.environment.comparisonWorkload).toMatchObject({
      activeContacts: 0,
      recipientPoolSize: 0,
      recipientPoolSource: 'lean_tenant',
      longConversationFixturePresent: false,
      largeBroadcastFixturePresent: false,
    });
    expect(JSON.stringify(summary.environment.comparisonWorkload)).not.toContain('raw-contact-id');
    expect(JSON.stringify(summary.environment.comparisonWorkload)).not.toContain('private.person@example.com');
  });

  it.each(['local', 'hosted-dev'] as const)('labels %s artifacts as existing data with no synthetic workload', async (target) => {
    const outputRoot = await artifactRoot();
    const base = reportInput(outputRoot, target === 'local' ? '20260812T123456789Z-01234568' : '20260812T123456789Z-01234569');
    const input = {
      ...base,
      config: { ...base.config, target, seed: null },
      target: {
        target,
        proof: target === 'local' ? 'local_stack' : 'hosted_dev',
        profilerCommit: null,
        targetAppCommit: null,
        targetVersionStatus: 'unverified',
      } as TargetMetadata,
    };

    await writePerformanceReport(input);

    const summary = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    expect(summary.environment).toMatchObject({ dataSource: 'existing', comparisonWorkload: null });
  });

  it('evaluates every checkpoint mismatch class while preserving absent conditionals', () => {
    const route = ROUTES.find((candidate) => candidate.surfaceId === '/contacts/tenants')!;
    const branch = { kind: 'none' } as const;
    const required = expectedGets(route, 'warm', branch).find((entry) => entry.requirement === 'required')!;
    const conditional = expectedGets(route, 'warm', branch).find((entry) => entry.requirement === 'conditional')!;
    const baseSample = sample(route.surfaceId, 'warm', 0, { blockedWrites: [], terminalState: 'populated' });
    const baseRequest: RequestEvidence = {
      ...request(route.surfaceId, 'warm', 0),
      endpointTemplate: required.endpointTemplate,
      queryKeys: [...required.queryKeys],
      requestRole: 'required',
      unmatchedApi: false,
    };
    const evaluate = (overrides: {
      sample?: SampleResult;
      requests?: RequestEvidence[];
      branches?: Array<{ surfaceId: string; mode: 'cold' | 'warm'; repeat: number; branch: RouteContractBranch }>;
    } = {}) => evaluateContractCheckpoint({
      routes: [route],
      samples: [overrides.sample ?? baseSample],
      requests: overrides.requests ?? [baseRequest],
      branches: overrides.branches ?? [{ surfaceId: route.surfaceId, mode: 'warm', repeat: 0, branch }],
    });

    expect(evaluate().mismatchCodes).toEqual([]);
    expect(evaluate({ requests: [baseRequest, {
      ...baseRequest,
      endpointTemplate: conditional.endpointTemplate,
      queryKeys: [...conditional.queryKeys],
    }] }).mismatchCodes).toEqual([]);
    expect(evaluate({ requests: [] }).mismatchCodes).toContain('missing_required_endpoint');
    expect(evaluate({ requests: [{ ...baseRequest, outcome: 'failed' }] }).mismatchCodes)
      .toContain('missing_required_endpoint');
    expect(evaluate({ requests: [{ ...baseRequest, status: 500 }] }).mismatchCodes)
      .toContain('missing_required_endpoint');
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

  it('does not let the unread badge satisfy the unread Inbox page checkpoint', () => {
    const route = ROUTES.find((candidate) => candidate.surfaceId === 'inbox-unread')!;
    const branch = { kind: 'none' } as const;
    const declared = expectedGets(route, 'cold', branch);
    const requests = declared.map((contract) => ({
      ...request(route.surfaceId, 'cold', 0),
      endpointTemplate: contract.endpointTemplate,
      queryKeys: [...contract.queryKeys],
      ...(contract.inboxRequestClass !== undefined && { inboxRequestClass: contract.inboxRequestClass }),
      requestRole: 'required' as const,
    }));
    const pageIndex = requests.findIndex((entry) => entry.inboxRequestClass === 'inbox_page_unread');
    expect(pageIndex).toBeGreaterThanOrEqual(0);
    const evaluate = (observed: RequestEvidence[]) => evaluateContractCheckpoint({
      routes: [route],
      samples: [sample(route.surfaceId, 'cold', 0, { blockedWrites: [], terminalState: 'populated' })],
      requests: observed,
      branches: [{ surfaceId: route.surfaceId, mode: 'cold', repeat: 0, branch }],
    });
    expect(evaluate(requests.filter((_, index) => index !== pageIndex)).mismatchCodes).toContain('missing_required_endpoint');
    expect(evaluate(requests).mismatchCodes).toEqual([]);
  });

  it('retains distinct closed unread Inbox request classes in report artifacts', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-1a2b3c4d');
    const route = ROUTES.find((candidate) => candidate.surfaceId === 'inbox-unread')!;
    input.config = { ...input.config, contractCheckpoint: true };
    input.samples = [sample(route.surfaceId, 'cold', 0, {
      blockedWrites: [], terminalState: 'populated',
    })];
    input.requests = expectedGets(route, 'cold', { kind: 'none' }).map((contract) => ({
      ...request(route.surfaceId, 'cold', 0),
      endpointTemplate: contract.endpointTemplate,
      queryKeys: [...contract.queryKeys],
      ...(contract.inboxRequestClass !== undefined && { inboxRequestClass: contract.inboxRequestClass }),
      requestRole: 'required' as const,
    }));
    Object.assign(input, {
      checkpointBranches: [{
        surfaceId: route.surfaceId, mode: 'cold', repeat: 0, branch: { kind: 'none' },
      }],
    });

    await writePerformanceReport(input);

    const requestLines = (await readFile(join(outputRoot, input.runId, 'requests.jsonl'), 'utf8'))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(requestLines.flatMap((line) => line.inboxRequestClass === undefined ? [] : [line.inboxRequestClass])).toEqual([
      'inbox_badge', 'inbox_page_unread',
    ]);
    const checkpoint = JSON.parse(await readFile(
      join(outputRoot, input.runId, 'contract-observations.json'),
      'utf8',
    )) as {
      observations: Array<{
        surfaceId: string;
        mode: 'cold' | 'warm';
        endpoints: Array<{ inboxRequestClass?: string }>;
      }>;
    };
    const inboxRequestClasses = checkpoint.observations
      .filter((observation) => observation.surfaceId === route.surfaceId && observation.mode === 'cold')
      .flatMap((observation) => observation.endpoints)
      .flatMap((endpoint) => (
        endpoint.inboxRequestClass === undefined ? [] : [endpoint.inboxRequestClass]
      ));
    expect(inboxRequestClasses).toEqual([
      'inbox_badge', 'inbox_page_unread',
    ]);
  });

  it('omits an unknown Inbox request class at the report artifact boundary', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-4d3c2b1a');
    input.requests = [{
      ...request('inbox-unread', 'cold', 0),
      inboxRequestClass: 'raw-filter=unread' as never,
    }];

    await expect(writePerformanceReport(input)).resolves.toMatchObject({ status: 'written', exitCode: 0 });

    const [requestLine] = (await readFile(join(outputRoot, input.runId, 'requests.jsonl'), 'utf8'))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(requestLine.inboxRequestClass).toBeUndefined();
  });

  it('requires the exact guarded automatic-write set and rejects tuples outside it', () => {
    const route = ROUTES.find((candidate) => candidate.surfaceId === '/conversations/:conversationId')!;
    const branch = { kind: 'none' } as const;
    const base = sample(route.surfaceId, 'warm', 0, { blockedWrites: [], terminalState: 'populated' });
    const declared = expectedGets(route, 'warm', branch).filter((entry) => entry.requirement === 'required');
    const requests = declared.map((entry) => ({
      ...request(route.surfaceId, 'warm', 0),
      endpointTemplate: entry.endpointTemplate,
      queryKeys: [...entry.queryKeys],
    }));
    const evaluate = (value: SampleResult) => evaluateContractCheckpoint({
      routes: [route], samples: [value], requests,
      branches: [{ surfaceId: route.surfaceId, mode: 'warm', repeat: 0, branch }],
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
        surfaceId: '/contacts/tenants', mode: 'warm', repeat: 0, branch: { kind: 'none' },
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
    const sharedPathSurfaces = [
      { surfaceId: 'inbox-unread', pathTemplate: '/inbox' },
      { surfaceId: 'inbox-unknown', pathTemplate: '/inbox' },
    ] as const;
    const secret = 'private.person@example.com';
    Object.assign(input.config as object, { baseUrl: `https://${secret}`, loginEmail: secret });
    Object.assign(input.target as object, { rawHost: secret });
    Object.assign(input.samples[0] as object, { rawRequests: [{ url: secret }], caughtError: new Error(secret) });
    Object.assign(input.requests[0] as object, { rawUrl: `https://${secret}`, headers: { authorization: secret } });
    Object.assign(input.browser as object, { executablePath: secret });
    Object.assign(input.routeOrders[0] as object, { rawRouteIds: [secret] });
    Object.assign(input.warmup as object, { rawUrl: secret });
    Object.assign(input.relayDomCheck as object, { rawRows: [secret] });
    expect(ROUTES.filter((route) => sharedPathSurfaces.some((surface) => surface.surfaceId === route.surfaceId))
      .map((route) => ({ surfaceId: route.surfaceId, pathTemplate: route.pathTemplate })))
      .toEqual(sharedPathSurfaces);
    input.samples.push(...sharedPathSurfaces.map((surface, index) => (
      sample(surface.surfaceId, 'cold', 0, { readyMs: 110 + (index * 10), clientTruncated: false })
    )));
    input.requests.push(...sharedPathSurfaces.map((surface) => request(surface.surfaceId, 'cold', 0)));

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

    expect(summary.schemaVersion).toBe(2);
    expect(Object.keys(summary).sort()).toEqual([
      'aggregates', 'artifacts', 'browser', 'comparison', 'config', 'environment',
      'interceptionScopeVersion', 'manifest', 'outOfSampleWrites', 'rankings', 'registryVersion', 'relayDomCheck', 'revisions',
      'routeOrders', 'run', 'runtime', 'samples', 'schemaVersion', 'target', 'warmup', 'warnings',
      'workloadVersion',
    ].sort());
    expect(summary.interceptionScopeVersion).toBe(3);
    expect(summary.config.target).toBe('hermetic');
    expect(summary.config.baseUrl).toBeUndefined();
    expect(summary.target.rawHost).toBeUndefined();
    expect(summary.revisions).toEqual({ profilerCommit: 'abcdef1', targetAppCommit: '1234567' });
    expect(summary.browser).toEqual({
      name: 'chromium',
      channel: 'chromium',
      version: '140.0.7339.12',
      major: 140,
      httpCache: 'not_disabled_by_interception',
      viewport: { width: 1280, height: 720 },
    });
    expect(summary.runtime.node).toMatch(/^\d+\.\d+\.\d+/u);
    expect(summary.runtime.os).toMatch(/^(?:aix|darwin|freebsd|linux|openbsd|sunos|win32)\/(?:arm|arm64|ia32|loong64|mips|mipsel|ppc|ppc64|riscv64|s390|s390x|x64)$/u);
    expect(summary.samples[0].rawRequests).toBeUndefined();
    expect(summary.samples[0].surfaceEvidence).toBeNull();
    expect(summary.samples[1].surfaceEvidence).toEqual({
      kind: 'inbox', filter: 'all', renderedRowCount: 10, groupsTruncated: false, initialInboxPageRequestCount: 1,
    });
    expect(summary.samples[2].surfaceEvidence).toEqual({ kind: 'conversation_detail', initialRenderedMessageCount: null });
    expect(summary.samples.filter((sample: { surfaceId: string }) => sharedPathSurfaces.some((surface) => surface.surfaceId === sample.surfaceId))
      .map((sample: { surfaceId: string }) => sample.surfaceId))
      .toEqual(sharedPathSurfaces.map((surface) => surface.surfaceId));
    expect(summary.samples[0].blockedWrites).toEqual([{
      method: 'POST',
      endpointTemplate: '/api/inbox/:contactId/read',
      phase: 'destination_mount',
    }]);
    expect(summary.requests).toBeUndefined();
    expect(summary.aggregates[0].metrics.resourceCountsByClass.api).toBeDefined();
    expect(summary.aggregates[0].noise.backgroundRequestCount).toBeDefined();
    expect(summary.routeOrders).toEqual([
      { mode: 'cold', repeat: 0, surfaceIds: ['/contacts', 'inbox-all'] },
      { mode: 'warm', repeat: 0, surfaceIds: ['inbox-all', '/contacts', '/settings/notifications'] },
    ]);
    expect(summary.manifest.contacts).toBe(100);

    const requestLines = requestsText.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(requestLines).toHaveLength(4);
    expect(Object.keys(requestLines[0]).sort()).toEqual([
      'durationMs', 'endpointTemplate', 'method', 'mode', 'originClass', 'outcome',
      'queryKeys', 'repeat', 'requestRole', 'resourceClass', 'surfaceId', 'startOffsetMs',
      'status', 'transferBytes', 'ttfbMs', 'unmatchedApi',
    ].sort());
    expect(requestLines[0]).toMatchObject({ outcome: 'finished', requestRole: 'required' });
    expect(requestLines[1]).toMatchObject({ outcome: 'finished', requestRole: 'background_refresh' });
    expect(requestLines.slice(2).map((line: { surfaceId: string }) => line.surfaceId))
      .toEqual(sharedPathSurfaces.map((surface) => surface.surfaceId));
    expect(requestLines[0].rawUrl).toBeUndefined();

    expect(report).toContain('## Cold worst offenders');
    expect(report.indexOf('| /contacts | 900')).toBeLessThan(report.indexOf('| inbox-all | 100'));
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

  it('replaces a malformed native group roster with an empty closed value at the report boundary', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-deadbeef');
    input.config = {
      ...input.config,
      seed: { ...input.config.seed!, nativeGroupRosterSizes: null } as never,
    };

    await expect(writePerformanceReport(input)).resolves.toMatchObject({ status: 'written' });

    const summary = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    expect(summary.manifest.nativeGroupRosterSizes).toEqual([]);
  });

  it('retains the closed required-action skip status and reason in report aggregates', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-a1a1a1a1');
    input.samples = [sample('inbox-unread', 'warm', 0, {
      status: 'skipped_required_action_missing', reason: 'required_action_missing', readyMs: null, terminalState: 'unknown',
    })];

    await expect(writePerformanceReport(input)).resolves.toMatchObject({ status: 'written' });

    const summary = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    expect(summary.aggregates).toEqual(expect.arrayContaining([
      expect.objectContaining({ statusCounts: expect.objectContaining({ skipped_required_action_missing: 1 }) }),
    ]));
  });

  it('retains contradictory terminal as the closed timeout reason in the sanitized artifact', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-c0de0001');
    input.samples = [sample('inbox-unread', 'warm', 0, {
      status: 'timeout', reason: 'contradictory_terminal', readyMs: null, terminalState: 'contradictory_terminal',
    })];

    await expect(writePerformanceReport(input)).resolves.toMatchObject({ status: 'written' });

    const summary = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    expect(summary.samples[0]).toMatchObject({
      status: 'timeout', reason: 'contradictory_terminal', terminalState: 'contradictory_terminal',
    });
  });

  it('preserves out-of-sample evidence at run scope and emits its own checkpoint mismatch', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-eeee4444');
    input.config = { ...input.config, contractCheckpoint: true };
    Object.assign(input, {
      outOfSampleWrites: [
        {
          method: 'POST',
          endpointTemplate: '/api/inbox/:contactId/read',
          phase: 'out_of_sample',
        },
        {
          method: 'POST',
          endpointTemplate: '/api/conversations/:conversationId/read',
          phase: 'out_of_sample',
        },
        {
          method: 'POST',
          endpointTemplate: '/api/inbox/:contactId/read',
          phase: 'out_of_sample',
        },
      ],
    });

    const result = await writePerformanceReport(input);

    const summary = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    expect(result).toMatchObject({ status: 'checkpoint_mismatch', exitCode: 1 });
    expect(summary.samples.every((row: SampleResult) => row.blockedWrites.every((write) => write.phase !== 'out_of_sample'))).toBe(true);
    expect(summary.outOfSampleWrites).toEqual([
      {
        method: 'POST',
        endpointTemplate: '/api/inbox/:contactId/read',
        phase: 'out_of_sample',
      },
      {
        method: 'POST',
        endpointTemplate: '/api/conversations/:conversationId/read',
        phase: 'out_of_sample',
      },
      {
        method: 'POST',
        endpointTemplate: '/api/inbox/:contactId/read',
        phase: 'out_of_sample',
      },
    ]);
    const markdown = await readFile(join(outputRoot, input.runId, 'report.md'), 'utf8');
    expect(markdown).toContain('- WARNING: `out_of_sample_write`');
    const conversationRow = '| POST | /api/conversations/:conversationId/read | 1 |';
    const inboxRow = '| POST | /api/inbox/:contactId/read | 2 |';
    expect(markdown.match(new RegExp(conversationRow.replace(/[|/]/gu, '\\$&'), 'gu'))).toHaveLength(1);
    expect(markdown.match(new RegExp(inboxRow.replace(/[|/]/gu, '\\$&'), 'gu'))).toHaveLength(1);
    expect(markdown.indexOf(conversationRow)).toBeLessThan(markdown.indexOf(inboxRow));
    const checkpoint = JSON.parse(await readFile(
      join(outputRoot, input.runId, 'contract-observations.json'),
      'utf8',
    ));
    expect(checkpoint.mismatchCodes).toContain('out_of_sample_blocked_write');
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

  it('reports an old 28-surface, pre-projection baseline as explicitly comparison-workload incompatible', async () => {
    const outputRoot = await artifactRoot();
    const baselineInput = reportInput(outputRoot, '20260812T123456789Z-aabbccde');
    await writePerformanceReport(baselineInput);
    const baseline = JSON.parse(await readFile(join(outputRoot, baselineInput.runId, 'summary.json'), 'utf8'));
    baseline.environment.routeSet = ROUTES.slice(0, 28).map((route) => route.surfaceId);
    baseline.environment.comparisonWorkload = { workloadModelVersion: 2, contacts: 100 };
    const currentInput = {
      ...reportInput(outputRoot, '20260812T123456790Z-eeff0012'),
      baselineJson: JSON.stringify(baseline),
    };

    const result = await writePerformanceReport(currentInput);
    const comparison = JSON.parse(await readFile(join(outputRoot, currentInput.runId, 'comparison.json'), 'utf8'));

    expect(result).toMatchObject({ status: 'written', exitCode: 0 });
    expect(comparison).toMatchObject({ control: 'uncontrolled' });
    expect(comparison.mismatches).toContain('comparison_workload');
    expect(comparison.mismatches).toContain('route_set');
  });

  it.each([
    ['invalid data source', 'data_source', (baseline: Record<string, any>) => {
      baseline.environment.dataSource = 'private.person@example.com';
    }],
    ['missing data source', 'data_source', (baseline: Record<string, any>) => {
      delete baseline.environment.dataSource;
    }],
    ['invalid recipient pool source', 'comparison_workload', (baseline: Record<string, any>) => {
      baseline.environment.comparisonWorkload.recipientPoolSource = 'private.person@example.com';
    }],
    ['missing recipient pool source', 'comparison_workload', (baseline: Record<string, any>) => {
      delete baseline.environment.comparisonWorkload.recipientPoolSource;
    }],
  ])('keeps a baseline with %s uncontrolled without persisting its raw value', async (_label, mismatch, mutate) => {
    const outputRoot = await artifactRoot();
    const baselineInput = reportInput(outputRoot, '20260812T123456790Z-aabbccdf');
    await writePerformanceReport(baselineInput);
    const baseline = JSON.parse(await readFile(join(outputRoot, baselineInput.runId, 'summary.json'), 'utf8'));
    mutate(baseline);
    const currentInput = {
      ...reportInput(outputRoot, '20260812T123456790Z-eeff0013'),
      baselineJson: JSON.stringify(baseline),
    };

    const result = await writePerformanceReport(currentInput);

    expect(result).toMatchObject({ status: 'written', exitCode: 0 });
    const comparison = JSON.parse(await readFile(join(outputRoot, currentInput.runId, 'comparison.json'), 'utf8'));
    expect(comparison).toMatchObject({ control: 'uncontrolled' });
    expect(comparison.mismatches).toContain(mismatch);
    const summaryText = await readFile(join(outputRoot, currentInput.runId, 'summary.json'), 'utf8');
    expect(summaryText).not.toContain('private.person@example.com');
  });

  it.each([
    ['invalid target', 'target', (baseline: Record<string, any>) => {
      baseline.environment.target = 'private.person@example.com';
    }],
    ['missing target', 'target', (baseline: Record<string, any>) => {
      delete baseline.environment.target;
    }],
  ])('keeps a baseline with %s uncontrolled without persisting malformed target text', async (_label, mismatch, mutate) => {
    const outputRoot = await artifactRoot();
    const baselineInput = reportInput(outputRoot, '20260812T123456790Z-aabbccd1');
    await writePerformanceReport(baselineInput);
    const baseline = JSON.parse(await readFile(join(outputRoot, baselineInput.runId, 'summary.json'), 'utf8'));
    mutate(baseline);
    const currentInput = {
      ...reportInput(outputRoot, '20260812T123456790Z-eeff0014'),
      baselineJson: JSON.stringify(baseline),
    };

    const result = await writePerformanceReport(currentInput);

    expect(result).toMatchObject({ status: 'written', exitCode: 0 });
    const comparisonText = await readFile(join(outputRoot, currentInput.runId, 'comparison.json'), 'utf8');
    expect(JSON.parse(comparisonText)).toMatchObject({ control: 'uncontrolled' });
    expect(JSON.parse(comparisonText).mismatches).toContain(mismatch);
    expect(comparisonText).not.toContain('private.person@example.com');
    expect(await readFile(join(outputRoot, currentInput.runId, 'summary.json'), 'utf8'))
      .not.toContain('private.person@example.com');
  });

  it.each([
    ['missing zero-valued workload count', 'comparison_workload', (baseline: Record<string, any>) => {
      delete baseline.environment.comparisonWorkload.totalMessageCount;
    }],
    ['missing false fixture flag', 'comparison_workload', (baseline: Record<string, any>) => {
      delete baseline.environment.comparisonWorkload.longConversationFixturePresent;
    }],
  ])('keeps a baseline with %s uncontrolled instead of normalizing it to a valid workload value', async (_label, mismatch, mutate) => {
    const outputRoot = await artifactRoot();
    const base = reportInput(outputRoot, '20260812T123456790Z-aabbccd2');
    const input = {
      ...base,
      config: {
        ...base.config,
        seed: {
          ...base.config.seed!,
          totalMessageCount: 0,
          longConversationFixturePresent: false,
        },
      },
    };
    await writePerformanceReport(input);
    const baseline = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    mutate(baseline);
    const currentInput = {
      ...reportInput(outputRoot, '20260812T123456790Z-eeff0015'),
      config: input.config,
      baselineJson: JSON.stringify(baseline),
    };

    const result = await writePerformanceReport(currentInput);

    expect(result).toMatchObject({ status: 'written', exitCode: 0 });
    const comparison = JSON.parse(await readFile(join(outputRoot, currentInput.runId, 'comparison.json'), 'utf8'));
    expect(comparison).toMatchObject({ control: 'uncontrolled' });
    expect(comparison.mismatches).toContain(mismatch);
  });

  it('keeps a baseline with a missing zero-valued viewport field uncontrolled', async () => {
    const outputRoot = await artifactRoot();
    const baselineInput = reportInput(outputRoot, '20260812T123456790Z-aabbccd3');
    baselineInput.browser = { version: '140.0.7339.12', viewport: { width: 0, height: 720 } };
    await writePerformanceReport(baselineInput);
    const baseline = JSON.parse(await readFile(join(outputRoot, baselineInput.runId, 'summary.json'), 'utf8'));
    delete baseline.environment.viewport.width;
    const currentInput = {
      ...reportInput(outputRoot, '20260812T123456790Z-eeff0016'),
      browser: baselineInput.browser,
      baselineJson: JSON.stringify(baseline),
    };

    const result = await writePerformanceReport(currentInput);

    expect(result).toMatchObject({ status: 'written', exitCode: 0 });
    const comparison = JSON.parse(await readFile(join(outputRoot, currentInput.runId, 'comparison.json'), 'utf8'));
    expect(comparison).toMatchObject({ control: 'uncontrolled' });
    expect(comparison.mismatches).toContain('viewport');
  });

  it('round-trips every registry route through artifacts and a generated baseline', async () => {
    const outputRoot = await artifactRoot();
    const surfaceIds = ROUTES.map((route) => route.surfaceId);
    const baselineInput = reportInput(outputRoot, '20260812T123456790Z-11223344');
    baselineInput.samples = surfaceIds.map((key) => sample(key, 'cold', 0));
    baselineInput.requests = surfaceIds.map((key) => request(key, 'cold', 0));
    baselineInput.routeOrders = [{ mode: 'cold', repeat: 0, surfaceIds }];

    await expect(writePerformanceReport(baselineInput)).resolves.toMatchObject({ status: 'written' });
    const baselineJson = await readFile(join(outputRoot, baselineInput.runId, 'summary.json'), 'utf8');
    const baseline = JSON.parse(baselineJson) as Record<string, any>;

    expect(baseline.samples.map((row: SampleResult) => row.surfaceId)).toEqual(surfaceIds);
    expect(baseline.routeOrders[0].surfaceIds).toEqual(surfaceIds);
    expect(baseline.warmup.surfaceId).toBe('/');
    expect(baseline.aggregates.map((row: { surfaceId: string }) => row.surfaceId)).toEqual(surfaceIds);
    expect(baseline.rankings.cold.readyMs.some((row: { surfaceId: string }) => row.surfaceId === '/')).toBe(true);

    const currentInput = {
      ...reportInput(outputRoot, '20260812T123456790Z-55667788'),
      samples: surfaceIds.map((key) => sample(key, 'cold', 0)),
      requests: surfaceIds.map((key) => request(key, 'cold', 0)),
      routeOrders: [{ mode: 'cold' as const, repeat: 0, surfaceIds }],
      baselineJson,
    };
    const current = await writePerformanceReport(currentInput);

    expect(current).toMatchObject({ status: 'written', exitCode: 0 });
    const comparison = JSON.parse(await readFile(
      join(outputRoot, currentInput.runId, 'comparison.json'),
      'utf8',
    )) as Record<string, unknown>;
    expect(comparison['mismatches']).toEqual([]);
  });

  it('replaces unsafe route keys before they reach any artifact', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456790Z-a1b2c3d4');
    input.routeOrders = [{
      mode: 'cold', repeat: 0, surfaceIds: ['/a|b', '/contacts/perf-contact-00001'],
    }];

    const result = await writePerformanceReport(input);

    expect(result.status).toBe('written');
    const summaryText = await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8');
    expect(summaryText).not.toContain('/a|b');
    expect(summaryText).not.toContain('perf-contact-00001');
    expect(JSON.parse(summaryText).routeOrders[0].surfaceIds).toEqual(['invalid_route', 'invalid_route']);
  });

  it('rejects structurally invalid baseline aggregate entries before comparison publication', async () => {
    const outputRoot = await artifactRoot();
    const baselineInput = reportInput(outputRoot, '20260812T123456790Z-b1c2d3e4');
    await writePerformanceReport(baselineInput);
    const baseline = JSON.parse(await readFile(join(outputRoot, baselineInput.runId, 'summary.json'), 'utf8'));
    baseline.aggregates[0].surfaceId = '/bad|key';
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

  it('publishes sanitized escaped-write evidence in the partial artifact', async () => {
    const outputRoot = await artifactRoot();
    const input = {
      ...reportInput(outputRoot, '20260812T123456789Z-55551111'),
      partialReason: 'uncataloged_write_escaped_firewall' as const,
      safetyFailure: {
        reason: 'uncataloged_write_escaped_firewall' as const,
        method: 'POST' as const,
        endpointTemplate: 'unmatched_api',
      },
    };

    const result = await writePerformanceReport(input);

    expect(result).toMatchObject({ status: 'partial', exitCode: 1 });
    const summary = JSON.parse(await readFile(join(outputRoot, input.runId, 'summary.json'), 'utf8'));
    expect(summary.run).toEqual({ status: 'partial', reason: 'uncataloged_write_escaped_firewall' });
    expect(summary.safetyFailure).toEqual(input.safetyFailure);
    const markdown = await readFile(join(outputRoot, input.runId, 'report.md'), 'utf8');
    expect(markdown).toContain('Escaped write: `POST unmatched_api`');
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

  it('reopens closed staging handles and preserves the privacy failure category', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-12121212');
    const sensitiveValue = 'closed.handle.private@example.com';
    fsFaults.stagedSensitiveValue = sensitiveValue;
    fsFaults.closeStagingHandlesOnSensitiveMutation = true;
    fsFaults.stagingRemoveFailures = 100;

    const result = await writePerformanceReport(input);

    expect(result).toMatchObject({
      status: 'privacy_failure',
      reason: 'privacy_scan_failed',
      reasonCategories: ['email_address'],
    });
    const stagingDirectory = join(outputRoot, `${input.runId}-staging`);
    const stagingFiles = await readdir(stagingDirectory);
    const stagingTexts = await Promise.all(stagingFiles.map((fileName) => (
      readFile(join(stagingDirectory, fileName), 'utf8')
    )));
    expect(stagingTexts).toEqual(stagingFiles.map(() => ''));
    expect(stagingTexts.join('')).not.toContain(sensitiveValue);
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

  it('refuses publication when the run is already cancelled', async () => {
    const outputRoot = await artifactRoot();
    const input = reportInput(outputRoot, '20260812T123456789Z-34343434');
    const controller = new AbortController();
    controller.abort({ reason: 'interrupted' });

    await expect(writePerformanceReport({ ...input, signal: controller.signal }))
      .rejects.toMatchObject({ reason: 'interrupted' });
    await expect(readdir(join(outputRoot, input.runId))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(join(outputRoot, `${input.runId}-staging`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
