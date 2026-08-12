import { describe, expect, it, vi } from 'vitest';
import { sanitizeRequestUrl } from './templates.js';
import {
  NEVER_INTERCEPTED_PATHS,
  PROFILER_CONTEXT_OPTIONS,
  FirewallPhaseError,
  UnknownFirewallMethodError,
  createFirewallRecordingToken,
  installRequestFirewall,
  type FirewallRouteHandler,
  type FirewallRouteLike,
  type FirewallRoutePredicate,
  type FirewallRouteRegistrar,
} from './firewall.js';

const ORIGIN = 'https://dashboard.example.test';

class FakeContext implements FirewallRouteRegistrar {
  private predicate: FirewallRoutePredicate | null = null;
  private handler: FirewallRouteHandler | null = null;
  readonly originRequests: Array<{ method: string; url: string }> = [];
  readonly abortedRequests: Array<{ method: string; url: string }> = [];
  handlerCalls = 0;
  continueCalls = 0;

  async route(predicate: FirewallRoutePredicate, handler: FirewallRouteHandler): Promise<void> {
    this.predicate = predicate;
    this.handler = handler;
  }

  async issue(method: string, url: string, frameUrl = `${ORIGIN}/source`): Promise<'origin' | 'aborted'> {
    if (this.predicate === null || this.handler === null) throw new Error('firewall_not_installed');
    const request = {
      method: () => method,
      url: () => url,
      frame: () => ({ url: () => frameUrl }),
    };
    let outcome: 'origin' | 'aborted' | null = null;
    const route: FirewallRouteLike = {
      request: () => request,
      continue: async () => {
        this.continueCalls += 1;
        this.originRequests.push({ method, url });
        outcome = 'origin';
      },
      abort: async () => {
        this.abortedRequests.push({ method, url });
        outcome = 'aborted';
      },
    };
    if (!this.predicate(new URL(url))) {
      this.originRequests.push({ method, url });
      return 'origin';
    }
    this.handlerCalls += 1;
    await this.handler(route);
    if (outcome === null) throw new Error('route_not_settled');
    return outcome;
  }
}

describe('performance request firewall', () => {
  it('encodes service-worker blocking in the required browser context options', () => {
    expect(PROFILER_CONTEXT_OPTIONS).toEqual({ serviceWorkers: 'block' });
  });

  it('continues all read methods and aborts all write methods before the fake origin', async () => {
    const context = new FakeContext();
    const token = createFirewallRecordingToken({
      mode: 'cold',
      firstPartyOrigin: ORIGIN,
      destinationPageUrl: `${ORIGIN}/contacts/contact-safe`,
    });
    await installRequestFirewall({ context, firstPartyOrigin: ORIGIN, currentToken: () => token });

    for (const [method, path] of [
      ['GET', '/api/contacts'],
      ['HEAD', '/auth/me'],
      ['OPTIONS', '/__dev/ping'],
    ] as const) {
      await expect(context.issue(method, `${ORIGIN}${path}`)).resolves.toBe('origin');
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await expect(context.issue(method, `${ORIGIN}/api/contacts/contact-safe`)).resolves.toBe('aborted');
    }

    expect(context.originRequests.map((request) => request.method)).toEqual(['GET', 'HEAD', 'OPTIONS']);
    expect(context.abortedRequests.map((request) => request.method)).toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
    expect(token.evidence()).toEqual([
      { method: 'POST', endpointTemplate: '/api/contacts/:contactId', phase: 'destination_mount' },
      { method: 'PUT', endpointTemplate: '/api/contacts/:contactId', phase: 'destination_mount' },
      { method: 'PATCH', endpointTemplate: '/api/contacts/:contactId', phase: 'destination_mount' },
      { method: 'DELETE', endpointTemplate: '/api/contacts/:contactId', phase: 'destination_mount' },
    ]);
    expect(Object.keys(token.evidence()[0] ?? {}).sort()).toEqual(['endpointTemplate', 'method', 'phase']);
  });

  it('never routes events through the handler, sanitizer, recorder, or continue', async () => {
    const context = new FakeContext();
    const sanitize = vi.fn(sanitizeRequestUrl);
    const token = createFirewallRecordingToken({
      mode: 'cold',
      firstPartyOrigin: ORIGIN,
      destinationPageUrl: `${ORIGIN}/`,
    });
    await installRequestFirewall({ context, firstPartyOrigin: ORIGIN, currentToken: () => token, sanitize });

    expect(NEVER_INTERCEPTED_PATHS).toEqual(['/api/events']);
    await expect(context.issue('GET', `${ORIGIN}/api/events?cursor=private`)).resolves.toBe('origin');
    expect(context.handlerCalls).toBe(0);
    expect(context.continueCalls).toBe(0);
    expect(sanitize).not.toHaveBeenCalled();
    expect(token.evidence()).toEqual([]);
    expect(context.originRequests).toHaveLength(1);
  });

  it('leaves static, public, media, and storage traffic outside interception', async () => {
    const context = new FakeContext();
    await installRequestFirewall({ context, firstPartyOrigin: ORIGIN, currentToken: () => null });
    const requests = [
      ['GET', `${ORIGIN}/assets/app.js`],
      ['POST', `${ORIGIN}/public/housing-fair`],
      ['POST', `${ORIGIN}/unit-media/unit-safe/media-safe`],
      ['POST', 'https://storage.example.test/private-upload'],
      ['POST', 'https://third-party.example.test/api/write'],
    ] as const;
    for (const [method, url] of requests) {
      await expect(context.issue(method, url)).resolves.toBe('origin');
    }
    expect(context.handlerCalls).toBe(0);
    expect(context.continueCalls).toBe(0);
    expect(context.originRequests).toHaveLength(requests.length);
  });

  it('classifies a same-document warm race from the frame URL at each interception', async () => {
    const context = new FakeContext();
    const source = `${ORIGIN}/inbox`;
    const destination = `${ORIGIN}/conversations/conv-safe`;
    const token = createFirewallRecordingToken({
      mode: 'warm',
      firstPartyOrigin: ORIGIN,
      sourcePageUrl: source,
      destinationPageUrl: destination,
    });
    await installRequestFirewall({ context, firstPartyOrigin: ORIGIN, currentToken: () => token });

    await context.issue('POST', `${ORIGIN}/api/conversations/conv-safe/read`, destination);
    await context.issue('POST', `${ORIGIN}/api/inbox/contact-safe/read`, source);
    expect(token.evidence()).toEqual([
      { method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
      { method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'source_click' },
    ]);
  });

  it('tags an explicit source-equals-destination probe as source_click', async () => {
    const context = new FakeContext();
    const page = `${ORIGIN}/email`;
    const token = createFirewallRecordingToken({
      mode: 'warm',
      firstPartyOrigin: ORIGIN,
      sourcePageUrl: page,
      destinationPageUrl: page,
      noNavigationProbe: true,
    });
    await installRequestFirewall({ context, firstPartyOrigin: ORIGIN, currentToken: () => token });
    await context.issue('POST', `${ORIGIN}/api/unmatched-email/um-safe/read`, page);
    expect(token.evidence()).toEqual([
      { method: 'POST', endpointTemplate: '/api/unmatched-email/:unmatchedId/read', phase: 'source_click' },
    ]);
  });

  it('keeps prior preparation writes out of a fresh sample token', async () => {
    const context = new FakeContext();
    let token = null as ReturnType<typeof createFirewallRecordingToken> | null;
    await installRequestFirewall({ context, firstPartyOrigin: ORIGIN, currentToken: () => token });
    await expect(context.issue('POST', `${ORIGIN}/api/inbox/contact-prep/read`)).resolves.toBe('aborted');

    token = createFirewallRecordingToken({
      mode: 'cold',
      firstPartyOrigin: ORIGIN,
      destinationPageUrl: `${ORIGIN}/contacts/contact-fresh`,
    });
    await context.issue('POST', `${ORIGIN}/api/inbox/contact-fresh/read`, `${ORIGIN}/contacts/contact-fresh`);
    expect(token.evidence()).toEqual([
      { method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' },
    ]);
    expect(context.abortedRequests).toHaveLength(2);
  });

  it('fails a third-page warm write and an unknown scoped method without reaching origin', async () => {
    const context = new FakeContext();
    const token = createFirewallRecordingToken({
      mode: 'warm',
      firstPartyOrigin: ORIGIN,
      sourcePageUrl: `${ORIGIN}/inbox`,
      destinationPageUrl: `${ORIGIN}/conversations/conv-safe`,
    });
    await installRequestFirewall({ context, firstPartyOrigin: ORIGIN, currentToken: () => token });

    await expect(context.issue('POST', `${ORIGIN}/api/inbox/contact-safe/read`, `${ORIGIN}/settings/team`))
      .rejects.toBeInstanceOf(FirewallPhaseError);
    await expect(context.issue('PROPFIND', `${ORIGIN}/api/contacts`))
      .rejects.toBeInstanceOf(UnknownFirewallMethodError);
    expect(context.originRequests).toEqual([]);
    expect(context.abortedRequests).toHaveLength(2);
    expect(token.evidence()).toEqual([]);
  });
});
