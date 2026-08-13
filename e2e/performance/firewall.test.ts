import { describe, expect, it, vi } from 'vitest';
import {
  INTERCEPTION_SCOPE_VERSION,
  NEVER_INTERCEPTED_PATHS,
  PROFILER_CONTEXT_OPTIONS,
  FirewallHandlerError,
  FirewallPhaseError,
  UnknownFirewallMethodError,
  createFirewallRecordingToken,
  firewallRequestPatterns,
  installRequestFirewall,
  isFirewallScopedUrl,
  type FirewallCdpSession,
  type FirewallPausedRequest,
} from './firewall.js';

const ORIGIN = 'https://dashboard.example.test';

class FakeSession implements FirewallCdpSession {
  readonly sent: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  readonly handlers = new Map<string, Array<(event: never) => void>>();
  frameUrl = `${ORIGIN}/source`;
  detached = false;
  continueRequestFailure: Error | null = null;
  frameTreeFailure: Error | null = null;
  pausedDuringFetchDisable: FirewallPausedRequest | null = null;
  pausedAfterNextFrameTree: FirewallPausedRequest | null = null;

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === 'Fetch.continueRequest' && this.continueRequestFailure !== null) {
      const error = this.continueRequestFailure;
      this.continueRequestFailure = null;
      throw error;
    }
    if (method === 'Page.getFrameTree') {
      if (this.frameTreeFailure !== null) throw this.frameTreeFailure;
      if (this.pausedAfterNextFrameTree !== null) {
        const event = this.pausedAfterNextFrameTree;
        this.pausedAfterNextFrameTree = null;
        setTimeout(() => this.emitPaused(event), 0);
      }
      return { frameTree: { frame: { id: 'main', url: this.frameUrl } } };
    }
    if (method === 'Fetch.disable' && this.pausedDuringFetchDisable !== null) {
      const event = this.pausedDuringFetchDisable;
      this.pausedDuringFetchDisable = null;
      this.emitPaused(event);
    }
    return {};
  }

  on(event: string, listener: (value: never) => void): this {
    const listeners = this.handlers.get(event) ?? [];
    listeners.push(listener);
    this.handlers.set(event, listeners);
    return this;
  }

  async detach(): Promise<void> {
    this.detached = true;
  }

  emitPaused(event: FirewallPausedRequest): void {
    for (const listener of this.handlers.get('Fetch.requestPaused') ?? []) listener(event as never);
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.handlers.get(event) ?? []) listener(value as never);
  }
}

class FakePage {
  currentUrl = `${ORIGIN}/source`;
  readonly session = new FakeSession();

  url(): string {
    return this.currentUrl;
  }

  context(): { newCDPSession: () => Promise<FirewallCdpSession> } {
    return { newCDPSession: async () => this.session };
  }
}

function paused(method: string, path: string, referrer?: string): FirewallPausedRequest {
  return {
    requestId: `${method}-${path}`,
    request: {
      method,
      url: `${ORIGIN}${path}`,
      ...(referrer === undefined ? {} : { headers: { Referer: referrer } }),
    },
    resourceType: 'Fetch',
    frameId: 'main',
  };
}

function sentMethods(page: FakePage): string[] {
  return page.session.sent.map((row) => row.method);
}

describe('performance request firewall', () => {
  it('blocks service workers and publishes the scoped CDP interception version', () => {
    expect(PROFILER_CONTEXT_OPTIONS).toEqual({ serviceWorkers: 'block' });
    expect(INTERCEPTION_SCOPE_VERSION).toBe(3);
  });

  it('pushes only cataloged first-party mutation patterns into the browser', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    const enable = page.session.sent.find((row) => row.method === 'Fetch.enable');
    const patterns = (enable?.params?.['patterns'] as Array<{ urlPattern: string }>).map((row) => row.urlPattern);

    expect(patterns).toEqual(firewallRequestPatterns(ORIGIN).map((urlPattern) => ({ urlPattern }).urlPattern));
    expect(patterns.every((pattern) => pattern.startsWith(ORIGIN))).toBe(true);
    expect(patterns.some((pattern) => pattern.includes('/assets/'))).toBe(false);
    expect(patterns.some((pattern) => pattern.includes('/api/events'))).toBe(false);
    expect(sentMethods(page)).not.toContain('Network.setCacheDisabled');
    await controller.dispose();
  });

  it('pauses a query-bearing templated mutation before the network', async () => {
    const page = new FakePage();
    const token = createFirewallRecordingToken({
      mode: 'cold', firstPartyOrigin: ORIGIN, destinationPageUrl: `${ORIGIN}/tours/tour-safe`,
    });
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => token });
    const enable = page.session.sent.find((row) => row.method === 'Fetch.enable');
    const patterns = (enable?.params?.['patterns'] as Array<{ urlPattern: string }>).map((row) => row.urlPattern);

    expect(patterns).toContain(`${ORIGIN}/api/tours/*/reminders/*/send-now?*`);
    page.session.emitPaused(paused(
      'POST',
      '/api/tours/tour-safe/reminders/reminder-safe/send-now?force=send_now',
    ));
    await controller.assertHealthy();

    expect(token.evidence()).toEqual([{
      method: 'POST',
      endpointTemplate: '/api/tours/:tourId/reminders/:reminderId/send-now',
      phase: 'destination_mount',
    }]);
    expect(sentMethods(page)).toContain('Fetch.failRequest');
    await controller.dispose();
  });

  it('never scopes events, static assets, public routes, media, or third-party traffic', () => {
    expect(NEVER_INTERCEPTED_PATHS).toEqual(['/api/events']);
    for (const url of [
      `${ORIGIN}/api/events?cursor=private`,
      `${ORIGIN}/assets/app.js`,
      `${ORIGIN}/public/housing-fair`,
      `${ORIGIN}/unit-media/unit-safe/media-safe`,
      'https://storage.example.test/private-upload',
      'https://third-party.example.test/api/write',
    ]) {
      expect(isFirewallScopedUrl(url, ORIGIN)).toBe(false);
    }
  });

  it('continues read methods and aborts all known writes before the network', async () => {
    const page = new FakePage();
    const token = createFirewallRecordingToken({
      mode: 'cold', firstPartyOrigin: ORIGIN, destinationPageUrl: `${ORIGIN}/contacts/contact-safe`,
    });
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => token });

    for (const method of ['GET', 'HEAD', 'OPTIONS']) page.session.emitPaused(paused(method, '/api/contacts'));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      page.session.emitPaused(paused(method, '/api/contacts/contact-safe'));
    }
    await controller.assertHealthy();

    expect(sentMethods(page).filter((method) => method === 'Fetch.continueRequest')).toHaveLength(3);
    expect(sentMethods(page).filter((method) => method === 'Fetch.failRequest')).toHaveLength(4);
    expect(token.evidence().map((row) => row.method)).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
    await controller.dispose();
  });

  it('ignores only an invalidated paused-read race and latches every other continue failure', async () => {
    const page = new FakePage();
    page.session.continueRequestFailure = new Error(
      'Protocol error (Fetch.continueRequest): Invalid InterceptionId.',
    );
    const controller = await installRequestFirewall({
      page,
      firstPartyOrigin: ORIGIN,
      currentToken: () => null,
    });

    page.session.emitPaused(paused('GET', '/api/contacts'));
    await expect(controller.assertHealthy()).resolves.toBeUndefined();
    await controller.dispose();

    const fatalPage = new FakePage();
    fatalPage.session.continueRequestFailure = new Error('Protocol transport failed');
    const fatal = await installRequestFirewall({
      page: fatalPage,
      firstPartyOrigin: ORIGIN,
      currentToken: () => null,
    });
    fatalPage.session.emitPaused(paused('GET', '/api/contacts'));
    await expect(fatal.assertHealthy()).rejects.toBeInstanceOf(FirewallHandlerError);
    await fatal.dispose();
  });

  it('classifies warm writes from immutable request referrers after the frame URL has advanced', async () => {
    const page = new FakePage();
    const token = createFirewallRecordingToken({
      mode: 'warm',
      firstPartyOrigin: ORIGIN,
      sourcePageUrl: `${ORIGIN}/inbox`,
      destinationPageUrl: `${ORIGIN}/conversations/conv-safe`,
    });
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => token });

    page.currentUrl = `${ORIGIN}/conversations/conv-safe`;
    page.session.emit('Page.navigatedWithinDocument', {
      frameId: 'main',
      url: `${ORIGIN}/conversations/conv-safe`,
    });
    page.session.emitPaused(paused(
      'POST',
      '/api/conversations/conv-safe/read',
      `${ORIGIN}/inbox`,
    ));
    await controller.assertHealthy();
    page.session.emitPaused(paused(
      'POST',
      '/api/conversations/conv-safe/read',
      `${ORIGIN}/conversations/conv-safe`,
    ));
    await controller.assertHealthy();

    expect(token.evidence().map((row) => row.phase)).toEqual(['source_click', 'destination_mount']);
    await controller.dispose();
  });

  it('records tokenless writes as out-of-sample evidence without poisoning later samples', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    page.session.emitPaused(paused('POST', '/api/inbox/contact-safe/read'));

    await expect(controller.assertHealthy()).resolves.toBeUndefined();
    expect((controller as never as { drainOutOfSampleEvidence(): unknown }).drainOutOfSampleEvidence()).toEqual([{
      method: 'POST',
      endpointTemplate: '/api/inbox/:contactId/read',
      phase: 'out_of_sample',
    }]);
    expect((controller as never as { drainOutOfSampleEvidence(): unknown }).drainOutOfSampleEvidence()).toEqual([]);
    expect(sentMethods(page)).toContain('Fetch.failRequest');
    await expect(controller.dispose()).resolves.toBeUndefined();
  });

  it('fails closed when the runtime watchdog sees an uncataloged first-party write escape Fetch', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    page.session.emit('Network.requestWillBeSent', {
      requestId: 'escaped-1',
      request: { method: 'POST', url: `${ORIGIN}/api/new-uncataloged-mutation?contact=private` },
      type: 'Fetch',
    });

    await expect(controller.assertHealthy()).rejects.toMatchObject({
      reason: 'uncataloged_write_escaped_firewall',
      evidence: {
        method: 'POST',
        endpointTemplate: 'unmatched_api',
      },
    });
    expect(JSON.stringify(controller)).not.toContain('private');
    await controller.dispose().catch(() => undefined);
  });

  it('waits for a protocol barrier and grace re-check before declaring a paired write escaped', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    page.session.pausedAfterNextFrameTree = {
      ...paused('POST', '/api/inbox/contact-safe/read'),
      networkId: 'paired-after-barrier',
    };
    page.session.emit('Network.requestWillBeSent', {
      requestId: 'paired-after-barrier',
      request: { method: 'POST', url: `${ORIGIN}/api/inbox/contact-safe/read` },
      type: 'Fetch',
    });

    await expect(controller.assertHealthy()).resolves.toBeUndefined();
    expect(sentMethods(page)).toContain('Fetch.failRequest');
    await controller.dispose();
  });

  it('reclaims a canceled watchdog candidate before declaring an escape', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    page.session.emit('Network.requestWillBeSent', {
      requestId: 'canceled-write',
      request: { method: 'POST', url: `${ORIGIN}/api/new-uncataloged-mutation` },
      type: 'Fetch',
    });
    page.session.emit('Network.loadingFailed', {
      requestId: 'canceled-write',
      canceled: true,
    });

    await expect(controller.assertHealthy()).resolves.toBeUndefined();
    await controller.dispose();
  });

  it('does not convert a closed-target teardown into an escaped-write failure', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    page.session.emit('Network.requestWillBeSent', {
      requestId: 'target-closed',
      request: { method: 'POST', url: `${ORIGIN}/api/new-uncataloged-mutation` },
      type: 'Fetch',
    });
    page.session.frameTreeFailure = new Error('Protocol error: Target closed');

    await expect(controller.dispose()).resolves.toBeUndefined();
    expect(page.session.detached).toBe(true);
  });

  it('keeps genuine protocol barrier faults fail-closed', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    page.session.emit('Network.requestWillBeSent', {
      requestId: 'barrier-fault',
      request: { method: 'POST', url: `${ORIGIN}/api/new-uncataloged-mutation` },
      type: 'Fetch',
    });
    page.session.frameTreeFailure = new Error('Protocol transport failed');

    await expect(controller.assertHealthy()).rejects.toBeInstanceOf(FirewallHandlerError);
    await controller.dispose();
  });

  it('cleans finished paused request ids so reuse cannot hide a later write', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    page.session.emitPaused({
      ...paused('POST', '/api/inbox/contact-safe/read'),
      networkId: 'reused-request-id',
    });
    await controller.assertHealthy();
    page.session.emit('Network.loadingFinished', { requestId: 'reused-request-id' });
    page.session.emit('Network.requestWillBeSent', {
      requestId: 'reused-request-id',
      request: { method: 'POST', url: `${ORIGIN}/api/new-uncataloged-mutation` },
      type: 'Fetch',
    });

    await expect(controller.assertHealthy()).rejects.toMatchObject({
      reason: 'uncataloged_write_escaped_firewall',
    });
    await controller.dispose();
  });

  it('offers a latched-failure-only health check for readiness polling', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    page.session.emit('Network.requestWillBeSent', {
      requestId: 'still-pending',
      request: { method: 'POST', url: `${ORIGIN}/api/new-uncataloged-mutation` },
      type: 'Fetch',
    });
    const barrierCount = sentMethods(page).filter((method) => method === 'Page.getFrameTree').length;

    await expect(controller.assertHealthy({ settle: false })).resolves.toBeUndefined();
    expect(sentMethods(page).filter((method) => method === 'Page.getFrameTree')).toHaveLength(barrierCount);

    page.session.emit('Network.loadingFailed', { requestId: 'still-pending', canceled: true });
    await controller.dispose();
  });

  it('latches third-page and unknown-method failures without rejecting the CDP callback', async () => {
    const page = new FakePage();
    const token = createFirewallRecordingToken({
      mode: 'warm',
      firstPartyOrigin: ORIGIN,
      sourcePageUrl: `${ORIGIN}/inbox`,
      destinationPageUrl: `${ORIGIN}/conversations/conv-safe`,
    });
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => token });

    page.currentUrl = `${ORIGIN}/settings/team`;
    expect(() => page.session.emitPaused(paused('POST', '/api/inbox/contact-safe/read'))).not.toThrow();
    await expect(controller.assertHealthy()).rejects.toBeInstanceOf(FirewallPhaseError);
    await controller.dispose();

    const nextPage = new FakePage();
    const next = await installRequestFirewall({ page: nextPage, firstPartyOrigin: ORIGIN, currentToken: () => token });
    expect(() => nextPage.session.emitPaused(paused('PROPFIND', '/api/contacts'))).not.toThrow();
    await expect(next.assertHealthy()).rejects.toBeInstanceOf(UnknownFirewallMethodError);
    await next.dispose();
  });

  it('disables Fetch interception and detaches its CDP session on disposal', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    await controller.dispose();

    expect(sentMethods(page)).toContain('Fetch.disable');
    expect(page.session.detached).toBe(true);
  });

  it('surfaces an unobserved handler failure during disposal after releasing CDP state', async () => {
    const page = new FakePage();
    const token = createFirewallRecordingToken({
      mode: 'warm',
      firstPartyOrigin: ORIGIN,
      sourcePageUrl: `${ORIGIN}/inbox`,
      destinationPageUrl: `${ORIGIN}/conversations/conv-safe`,
    });
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => token });
    page.session.emitPaused(paused(
      'POST',
      '/api/inbox/contact-safe/read',
      `${ORIGIN}/settings/team`,
    ));

    await expect(controller.dispose()).rejects.toBeInstanceOf(FirewallPhaseError);
    expect(sentMethods(page)).toContain('Fetch.disable');
    expect(page.session.detached).toBe(true);
  });

  it('drains and fails closed for a paused request delivered while Fetch is disabling', async () => {
    const page = new FakePage();
    const controller = await installRequestFirewall({ page, firstPartyOrigin: ORIGIN, currentToken: () => null });
    page.session.pausedDuringFetchDisable = paused('PROPFIND', '/api/contacts');

    await expect(controller.dispose()).rejects.toBeInstanceOf(UnknownFirewallMethodError);

    expect(sentMethods(page)).toContain('Fetch.failRequest');
    expect(page.session.detached).toBe(true);
  });
});
