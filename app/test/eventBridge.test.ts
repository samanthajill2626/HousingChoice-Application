import { describe, expect, it, vi } from 'vitest';
import { APP_EVENT_NAMES, createEventBus } from '../src/lib/events.js';
import { attachEventBridge, deriveBridgeToken } from '../src/lib/eventBridge.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

// Cross-process event bridge, WORKER side (spec:
// docs/superpowers/specs/2026-07-20-event-bridge-design.md). Contract:
// deriveBridgeToken is deterministic/hex; attachEventBridge subscribes ONE
// listener per AppEventMap name and fire-and-forgets a POST carrying both auth
// headers; failures never throw into the emitter and warn with the event NAME
// only - NEVER the payload (PII posture, doc section 9).

const OPTS = {
  targetUrl: 'http://127.0.0.1:9999',
  bridgeToken: deriveBridgeToken('test-session-secret'),
  originSecret: 'test-origin-secret',
};

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
}

/** A logger that discards output - for cases that do not inspect the log. */
function silentLogger() {
  return createLogger({ destination: createLogCapture().stream });
}

describe('deriveBridgeToken', () => {
  it('is deterministic, hex, 64 chars, and secret-dependent', () => {
    const a = deriveBridgeToken('secret-a');
    expect(a).toBe(deriveBridgeToken('secret-a'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(deriveBridgeToken('secret-b'));
  });
});

describe('attachEventBridge', () => {
  it('subscribes exactly one listener per AppEventMap name', () => {
    const bus = createEventBus();
    attachEventBridge(bus, { ...OPTS, logger: silentLogger(), fetchImpl: okFetch() });
    expect(APP_EVENT_NAMES).toHaveLength(7);
    for (const name of APP_EVENT_NAMES) {
      expect(bus.listenerCount(name)).toBe(1);
    }
  });

  it('POSTs name+payload to /internal/events with both auth headers', async () => {
    const bus = createEventBus();
    const fetchImpl = okFetch();
    attachEventBridge(bus, { ...OPTS, logger: silentLogger(), fetchImpl });
    bus.emit('suggestion.updated', { contactId: 'c-1' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:9999/internal/events');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-origin-verify']).toBe('test-origin-secret');
    expect(headers['x-bridge-token']).toBe(OPTS.bridgeToken);
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'suggestion.updated',
      payload: { contactId: 'c-1' },
    });
  });

  it('a rejected fetch never throws into the emitter and warns WITHOUT the payload', async () => {
    const bus = createEventBus();
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    attachEventBridge(bus, { ...OPTS, logger, fetchImpl });
    expect(() => bus.emit('suggestion.updated', { contactId: 'pii-guard' })).not.toThrow();
    await vi.waitFor(() => expect(capture.atLevel(40)).toHaveLength(1));
    const line = JSON.stringify(capture.atLevel(40)[0]);
    expect(line).toContain('suggestion.updated');
    expect(line).not.toContain('pii-guard');
  });

  it('a non-2xx response warns (name only) and never throws', async () => {
    const bus = createEventBus();
    const capture = createLogCapture();
    const logger = createLogger({ destination: capture.stream });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    attachEventBridge(bus, { ...OPTS, logger, fetchImpl });
    bus.emit('tour.updated', { tourId: 't-1', status: 'scheduled' });
    await vi.waitFor(() => expect(capture.atLevel(40)).toHaveLength(1));
    const line = JSON.stringify(capture.atLevel(40)[0]);
    expect(line).toContain('tour.updated');
    expect(line).toContain('403');
    expect(line).not.toContain('t-1');
  });
});
