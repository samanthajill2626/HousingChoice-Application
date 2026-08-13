// App-side helpers for the native group-texting specs: the log tail and the
// guardrail ticks.
//
// A16 IS THE REASON THE TICKS ARE HERE AT ALL. The hermetic lane runs jobs
// in-process in the APP *and* spawns a real worker with its own pollers. Only
// the app's log lines reach `/__dev/logtail`, so every guardrail line a spec
// asserts must be driven through an APP-side tick. Waiting on the worker's copy
// would produce a spec that passes or fails on timing, and proves nothing
// either way.
import type { APIRequestContext } from '@playwright/test';
import { appUrl } from '../support/urls.js';

const APP = appUrl;

export interface LogLine {
  level: number;
  time: number;
  msg?: string;
  event?: string;
  [field: string]: unknown;
}

/**
 * The app process's retained WARN+ERROR lines.
 *
 * `capturing` is checked, not ignored: an empty `lines` from a stack that never
 * installed the ring is indistinguishable from a clean run, and a spec whose
 * whole claim is "no ERROR happened" would then pass against a structurally
 * silent surface.
 */
export async function readLogTail(
  request: APIRequestContext,
  filter: { level?: 'warn' | 'error'; since?: string; contains?: string; event?: string } = {},
): Promise<LogLine[]> {
  const query = new URLSearchParams();
  if (filter.level) query.set('level', filter.level);
  if (filter.since) query.set('since', filter.since);
  if (filter.contains) query.set('contains', filter.contains);
  if (filter.event) query.set('event', filter.event);
  const res = await request.get(`${APP}/__dev/logtail?${query.toString()}`);
  if (!res.ok()) throw new Error(`logtail failed: ${res.status()}`);
  const body = (await res.json()) as { capturing: boolean; lines: LogLine[] };
  if (!body.capturing) {
    throw new Error(
      'logtail is NOT capturing on this stack - an empty result would prove nothing. ' +
        'Check DEV_AUTH_ENABLED / NODE_ENV / DYNAMODB_ENDPOINT on the app process.',
    );
  }
  return body.lines;
}

/** Drop the retained lines so a spec can assert "nothing since I started".
 *  Playwright runs workers:1 here, so this never races another spec. */
export async function clearLogTail(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${APP}/__dev/logtail/clear`);
  if (!res.ok()) throw new Error(`logtail clear failed: ${res.status()}`);
}

export type GuardrailDuty =
  | 'crosscheck_sweep'
  | 'send_staleness'
  | 'channel_quiet'
  | 'heartbeat';

export interface GuardrailTickResult {
  ok: boolean;
  now: string;
  ran: string[];
  skipped: string[];
  results: Record<string, Record<string, unknown>>;
}

/**
 * Run the guardrail duties IN THE APP PROCESS.
 *
 * `force` defaults to TRUE on the endpoint, which is what stops the hermetic
 * worker's own poll from having just claimed the period and silently no-opping
 * a spec's tick. Pass `force: false` only when the cadence gate itself is what
 * is under test.
 */
export async function tickGuardrails(
  request: APIRequestContext,
  body: { now?: string; force?: boolean; duties?: GuardrailDuty[] } = {},
): Promise<GuardrailTickResult> {
  const res = await request.post(`${APP}/__dev/group-guardrails/tick`, { data: body });
  if (!res.ok()) throw new Error(`guardrail tick failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as GuardrailTickResult;
}

/** An ISO instant `minutes` into the future - how a spec steps past a grace
 *  deadline without waiting for it. */
export function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
