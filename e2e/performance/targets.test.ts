import { describe, expect, it, vi } from 'vitest';
import {
  SafeTargetError,
  captureProfilerCommit,
  createRawAppPortTransport,
  normalizeGitRevision,
  normalizeTargetBaseUrl,
  verifyHermeticTarget,
  verifyHostedTarget,
  verifyLocalTarget,
} from './targets.js';

const response = (status: number, body: unknown) => ({ status, json: async () => body });
const OWNER_TOKEN = '0123456789abcdef0123456789abcdef';

describe('performance target safety proofs', () => {
  it.each([
    ['http://localhost:5174', 'http://localhost:5174'],
    ['http://127.0.0.1:5174/', 'http://127.0.0.1:5174'],
    ['http://[::1]:5174', 'http://[::1]:5174'],
  ])('accepts exact local loopback spelling %s', (input, expected) => {
    expect(normalizeTargetBaseUrl('local', input)).toBe(expected);
  });

  it.each([
    'https://localhost:5174',
    'http://localhost:5173',
    'http://0.0.0.0:5174',
    'http://example.test:5174',
    'http://localhost:5174/path',
    'http://user:secret@localhost:5174',
  ])('refuses unsafe local base URL without echoing it', (input) => {
    expect(() => normalizeTargetBaseUrl('local', input)).toThrowError(SafeTargetError);
    try {
      normalizeTargetBaseUrl('local', input);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(input);
    }
  });

  it('uses only raw GET /__dev/ping for local proof and requires the exact lane-zero prefix', async () => {
    const rawFetch = vi.fn().mockResolvedValue(response(200, {
      dev: true,
      tablePrefix: 'hc-local-',
      appCommit: 'A1B2C3D',
    }));
    const result = await verifyLocalTarget({
      baseUrl: 'http://localhost:5174',
      rawFetch,
      profilerCommit: 'abcdef1',
    });
    expect(rawFetch).toHaveBeenCalledWith('http://localhost:5174/__dev/ping', { method: 'GET' });
    expect(result).toEqual({
      target: 'local',
      proof: 'local_stack',
      profilerCommit: 'abcdef1',
      targetAppCommit: 'a1b2c3d',
      targetVersionStatus: 'verified',
    });
  });

  it.each([
    [{ dev: false, tablePrefix: 'hc-local-' }, 'target_ping_not_dev'],
    [{ dev: true, tablePrefix: 'hc-local-9-' }, 'target_prefix_mismatch'],
    [{ dev: true, tablePrefix: 'prod-' }, 'target_prefix_mismatch'],
    [{ dev: true }, 'target_prefix_mismatch'],
  ])('reduces malformed local ping responses to a closed reason', async (body, reason) => {
    const rawSentinel = 'sensitive-host.example.test/contact-secret';
    const rawFetch = vi.fn().mockResolvedValue(response(200, { ...body, detail: rawSentinel }));
    await expect(verifyLocalTarget({
      baseUrl: 'http://localhost:5174',
      rawFetch,
      profilerCommit: 'abcdef1',
    })).rejects.toMatchObject({ reason });
    try {
      await verifyLocalTarget({ baseUrl: 'http://localhost:5174', rawFetch, profilerCommit: 'abcdef1' });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(rawSentinel);
    }
  });

  it('verifies a hermetic lane prefix and matching normalized revision pair', async () => {
    const result = await verifyHermeticTarget({
      appBaseUrl: 'http://127.0.0.1:9301',
      rawFetch: vi.fn().mockResolvedValue(response(200, {
        dev: true,
        tablePrefix: 'hc-local-3-',
        appCommit: 'ABCDEF1',
        profilerOwnerToken: OWNER_TOKEN,
      })),
      expectedTablePrefix: 'hc-local-3-',
      profilerCommit: 'abcdef1',
      expectedOwnerToken: OWNER_TOKEN,
    });
    expect(result.targetVersionStatus).toBe('verified');
    expect(result.targetAppCommit).toBe('abcdef1');
  });

  it('requires a positive hermetic lane prefix even when ping echoes the supplied value', async () => {
    await expect(verifyHermeticTarget({
      appBaseUrl: 'http://127.0.0.1:9301',
      rawFetch: vi.fn().mockResolvedValue(response(200, {
        dev: true,
        tablePrefix: 'hc-local-',
        appCommit: 'abcdef1',
      })),
      expectedTablePrefix: 'hc-local-',
      profilerCommit: 'abcdef1',
      expectedOwnerToken: OWNER_TOKEN,
    })).rejects.toMatchObject({ reason: 'target_prefix_mismatch' });
  });

  it('requires exact nonempty commit and owner-token identity for a hermetic child', async () => {
    await expect(verifyHermeticTarget({
      appBaseUrl: 'http://127.0.0.1:9301',
      rawFetch: vi.fn().mockResolvedValue(response(200, {
        dev: true,
        tablePrefix: 'hc-local-3-',
        appCommit: '7654321',
        profilerOwnerToken: OWNER_TOKEN,
      })),
      expectedTablePrefix: 'hc-local-3-',
      profilerCommit: 'abcdef1',
      expectedOwnerToken: OWNER_TOKEN,
    })).rejects.toMatchObject({ reason: 'target_revision_mismatch' });

    await expect(verifyHermeticTarget({
      appBaseUrl: 'http://127.0.0.1:9301',
      rawFetch: vi.fn().mockResolvedValue(response(200, {
        dev: true,
        tablePrefix: 'hc-local-3-',
        appCommit: '',
        profilerOwnerToken: OWNER_TOKEN,
      })),
      expectedTablePrefix: 'hc-local-3-',
      profilerCommit: 'abcdef1',
      expectedOwnerToken: OWNER_TOKEN,
    })).rejects.toMatchObject({ reason: 'target_revision_mismatch' });

    await expect(verifyHermeticTarget({
      appBaseUrl: 'http://127.0.0.1:9301',
      rawFetch: vi.fn().mockResolvedValue(response(200, {
        dev: true,
        tablePrefix: 'hc-local-3-',
        appCommit: 'abcdef1',
        profilerOwnerToken: 'fedcba9876543210fedcba9876543210',
      })),
      expectedTablePrefix: 'hc-local-3-',
      profilerCommit: 'abcdef1',
      expectedOwnerToken: OWNER_TOKEN,
    })).rejects.toMatchObject({ reason: 'target_owner_mismatch' });
  });

  it('requires hosted HTTPS, admin auth, and exact dev flags through dashboard requests', async () => {
    const dashboardRequest = vi.fn()
      .mockResolvedValueOnce(response(200, { userId: 'user-secret', email: 'person@example.test', role: 'admin' }))
      .mockResolvedValueOnce(response(200, { env: 'dev', host: 'sensitive.example.test' }));
    const result = await verifyHostedTarget({
      baseUrl: 'https://dev.example.test',
      headed: true,
      dashboardRequest,
      profilerCommit: 'abcdef1',
    });
    expect(dashboardRequest.mock.calls.map(([path]) => path)).toEqual(['/auth/me', '/api/system/flags']);
    expect(result).toEqual({
      target: 'hosted-dev',
      proof: 'hosted_dev',
      profilerCommit: 'abcdef1',
      targetAppCommit: null,
      targetVersionStatus: 'unverified',
    });
    expect(JSON.stringify(result)).not.toContain('sensitive.example.test');
    expect(JSON.stringify(result)).not.toContain('person@example.test');
  });

  it('returns a closed hosted proof refusal', async () => {
    await expect(verifyHostedTarget({
      baseUrl: 'https://dev.example.test',
      headed: false,
      dashboardRequest: vi.fn(),
      profilerCommit: null,
    })).rejects.toMatchObject({ reason: 'target_headed_required' });
    await expect(verifyHostedTarget({
      baseUrl: 'https://dev.example.test',
      headed: true,
      dashboardRequest: vi.fn().mockResolvedValue(response(200, { role: 'va', env: 'prod' })),
      profilerCommit: null,
    })).rejects.toMatchObject({ reason: 'target_admin_required' });
  });

  it('normalizes safe revisions and discards command failures and raw output', async () => {
    expect(normalizeGitRevision(' ABCDEF1\r\n')).toBe('abcdef1');
    expect(normalizeGitRevision('')).toBeNull();
    expect(normalizeGitRevision('branch-name')).toBeNull();
    expect(normalizeGitRevision('a'.repeat(41))).toBeNull();
    await expect(captureProfilerCommit(async () => ({
      ok: false,
      stdout: 'host-secret',
      stderr: 'email@example.test',
    }))).resolves.toBeNull();
  });

  it('exposes only raw app-port ping and performance reseed operations', async () => {
    const rawFetch = vi.fn().mockResolvedValue(response(200, { ok: true }));
    const transport = createRawAppPortTransport({
      appBaseUrl: 'http://127.0.0.1:9301',
      rawFetch,
    });
    expect(Object.keys(transport).sort()).toEqual(['performanceReseed', 'ping']);
    await transport.ping();
    await transport.performanceReseed({ input: {}, anchor: '2026-08-11T12:00:00.000Z' });
    expect(rawFetch.mock.calls).toEqual([
      ['http://127.0.0.1:9301/__dev/ping', { method: 'GET' }],
      ['http://127.0.0.1:9301/__dev/performance/reseed', {
        method: 'POST',
        body: JSON.stringify({ input: {}, anchor: '2026-08-11T12:00:00.000Z' }),
      }],
    ]);
  });

  it('discards raw app-port transport failures at their boundary', async () => {
    const sentinel = 'private@example.test https://secret-host.example.test/path';
    const transport = createRawAppPortTransport({
      appBaseUrl: 'http://127.0.0.1:9301',
      rawFetch: vi.fn().mockRejectedValue(new Error(sentinel)),
    });
    await expect(transport.ping()).rejects.toMatchObject({ reason: 'target_ping_failed' });
    await expect(transport.performanceReseed({})).rejects.toMatchObject({ reason: 'target_reseed_failed' });
    for (const operation of [transport.ping, () => transport.performanceReseed({})]) {
      try {
        await operation();
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain(sentinel);
      }
    }
  });
});
