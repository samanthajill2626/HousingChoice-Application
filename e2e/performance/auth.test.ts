import { describe, expect, it, vi } from 'vitest';
import {
  SafeAuthError,
  authenticateHermetic,
  authenticateHosted,
  authenticateLocal,
  type InMemoryStorageState,
} from './auth.js';

const response = (status: number, body: unknown) => ({ status, json: async () => body });
const storage: InMemoryStorageState = { cookies: [], origins: [] };

describe('performance target authentication', () => {
  it('requires local TTY and exact normalized confirmation before dashboard login', async () => {
    const dashboardRequest = vi.fn();
    await expect(authenticateLocal({
      baseUrl: 'http://localhost:5174/',
      email: 'founder@example.com',
      stdinIsTTY: false,
      readConfirmation: vi.fn(),
      dashboardRequest,
      storageState: vi.fn(),
    })).rejects.toMatchObject({ reason: 'local_tty_required' });
    expect(dashboardRequest).not.toHaveBeenCalled();

    await expect(authenticateLocal({
      baseUrl: 'http://localhost:5174/',
      email: 'founder@example.com',
      stdinIsTTY: true,
      readConfirmation: vi.fn().mockResolvedValue('PROFILE http://127.0.0.1:5174'),
      dashboardRequest,
      storageState: vi.fn(),
    })).rejects.toMatchObject({ reason: 'local_confirmation_mismatch' });
    expect(dashboardRequest).not.toHaveBeenCalled();
  });

  it('uses dashboard context for existing-user-only local login and admin verification', async () => {
    const dashboardRequest = vi.fn()
      .mockResolvedValueOnce(response(200, { role: 'admin', email: 'founder@example.com' }))
      .mockResolvedValueOnce(response(200, { role: 'admin', email: 'founder@example.com' }));
    const storageState = vi.fn().mockResolvedValue(storage);
    const result = await authenticateLocal({
      baseUrl: 'http://127.0.0.1:5174/',
      email: 'founder@example.com',
      stdinIsTTY: true,
      readConfirmation: vi.fn().mockResolvedValue('PROFILE http://127.0.0.1:5174'),
      dashboardRequest,
      storageState,
    });
    expect(dashboardRequest).toHaveBeenNthCalledWith(1, '/auth/dev-login', {
      method: 'POST',
      data: { email: 'founder@example.com', requireExisting: true },
    });
    expect(dashboardRequest).toHaveBeenNthCalledWith(2, '/auth/me', { method: 'GET' });
    expect(result).toEqual({ storageState: storage });
    expect(storageState).toHaveBeenCalledOnce();
  });

  it('defaults local login to the existing founder identity', async () => {
    const dashboardRequest = vi.fn()
      .mockResolvedValueOnce(response(200, { role: 'admin' }))
      .mockResolvedValueOnce(response(200, { role: 'admin' }));
    await authenticateLocal({
      baseUrl: 'http://localhost:5174',
      stdinIsTTY: true,
      readConfirmation: vi.fn().mockResolvedValue('PROFILE http://localhost:5174'),
      dashboardRequest,
      storageState: vi.fn().mockResolvedValue(storage),
    });
    expect(dashboardRequest).toHaveBeenNthCalledWith(1, '/auth/dev-login', {
      method: 'POST',
      data: { email: 'founder@example.com', requireExisting: true },
    });
  });

  it('authenticates the hermetic founder through dashboard origin only', async () => {
    const dashboardRequest = vi.fn()
      .mockResolvedValueOnce(response(200, { role: 'admin' }))
      .mockResolvedValueOnce(response(200, { role: 'admin' }));
    await authenticateHermetic({ dashboardRequest, storageState: vi.fn().mockResolvedValue(storage) });
    expect(dashboardRequest.mock.calls.map(([path]) => path)).toEqual(['/auth/dev-login', '/auth/me']);
  });

  it('does not retain raw login identities or response bodies in failures', async () => {
    const sentinelEmail = 'private.person@example.test';
    const sentinelBody = 'https://oauth.example.test/callback?token=secret';
    const dashboardRequest = vi.fn().mockResolvedValue(response(404, { error: sentinelBody }));
    await expect(authenticateLocal({
      baseUrl: 'http://localhost:5174',
      email: sentinelEmail,
      stdinIsTTY: true,
      readConfirmation: vi.fn().mockResolvedValue('PROFILE http://localhost:5174'),
      dashboardRequest,
      storageState: vi.fn(),
    })).rejects.toBeInstanceOf(SafeAuthError);
    try {
      await authenticateLocal({
        baseUrl: 'http://localhost:5174',
        email: sentinelEmail,
        stdinIsTTY: true,
        readConfirmation: vi.fn().mockResolvedValue('PROFILE http://localhost:5174'),
        dashboardRequest,
        storageState: vi.fn(),
      });
    } catch (error) {
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(sentinelEmail);
      expect(serialized).not.toContain(sentinelBody);
    }
  });

  it('polls headed hosted auth until admin, validates dev, closes the page, and keeps state in memory', async () => {
    const page = { close: vi.fn().mockResolvedValue(undefined) };
    const dashboardRequest = vi.fn()
      .mockResolvedValueOnce(response(401, { error: 'private' }))
      .mockResolvedValueOnce(response(200, { role: 'admin', email: 'private@example.test' }))
      .mockResolvedValueOnce(response(200, { env: 'dev', hostname: 'private.example.test' }));
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(100);
    const result = await authenticateHosted({
      headed: true,
      openLoginPage: vi.fn().mockResolvedValue(page),
      dashboardRequest,
      storageState: vi.fn().mockResolvedValue(storage),
      sleep: vi.fn().mockResolvedValue(undefined),
      now,
      timeoutMs: 1_000,
      pollMs: 100,
    });
    expect(result).toEqual({ storageState: storage });
    expect(page.close).toHaveBeenCalledOnce();
    expect(dashboardRequest.mock.calls.map(([path]) => path)).toEqual(['/auth/me', '/auth/me', '/api/system/flags']);
  });

  it('rejects hosted headless, non-admin timeout, and non-dev environment with closed reasons', async () => {
    await expect(authenticateHosted({
      headed: false,
      openLoginPage: vi.fn(),
      dashboardRequest: vi.fn(),
      storageState: vi.fn(),
      sleep: vi.fn(),
      now: vi.fn(),
      timeoutMs: 100,
      pollMs: 10,
    })).rejects.toMatchObject({ reason: 'hosted_headed_required' });

    const nonAdminPage = { close: vi.fn().mockResolvedValue(undefined) };
    await expect(authenticateHosted({
      headed: true,
      openLoginPage: vi.fn().mockResolvedValue(nonAdminPage),
      dashboardRequest: vi.fn().mockResolvedValue(response(200, { role: 'va' })),
      storageState: vi.fn(),
      sleep: vi.fn(),
      now: vi.fn().mockReturnValue(0),
      timeoutMs: 100,
      pollMs: 10,
    })).rejects.toMatchObject({ reason: 'hosted_admin_required' });
    expect(nonAdminPage.close).toHaveBeenCalledOnce();

    const timeoutPage = { close: vi.fn().mockResolvedValue(undefined) };
    await expect(authenticateHosted({
      headed: true,
      openLoginPage: vi.fn().mockResolvedValue(timeoutPage),
      dashboardRequest: vi.fn().mockResolvedValue(response(401, { error: 'unauthorized' })),
      storageState: vi.fn(),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(101),
      timeoutMs: 100,
      pollMs: 10,
    })).rejects.toMatchObject({ reason: 'hosted_auth_timeout', timeoutMs: 100 });
    expect(timeoutPage.close).toHaveBeenCalledOnce();

    const envPage = { close: vi.fn().mockResolvedValue(undefined) };
    await expect(authenticateHosted({
      headed: true,
      openLoginPage: vi.fn().mockResolvedValue(envPage),
      dashboardRequest: vi.fn()
        .mockResolvedValueOnce(response(200, { role: 'admin' }))
        .mockResolvedValueOnce(response(200, { env: 'prod', raw: 'secret-host' })),
      storageState: vi.fn().mockResolvedValue(storage),
      sleep: vi.fn(),
      now: vi.fn().mockReturnValue(0),
      timeoutMs: 100,
      pollMs: 10,
    })).rejects.toMatchObject({ reason: 'hosted_env_not_dev' });
    expect(envPage.close).toHaveBeenCalledOnce();
  });
});
