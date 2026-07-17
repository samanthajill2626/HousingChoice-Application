import type { APIRequestContext } from '@playwright/test';
import { postInboundSms } from './fakeTwilio.js';

// Control-plane helpers for the conversation-fact-extraction e2e slice.
//
// The hermetic stack runs the DETERMINISTIC FAKE extraction driver
// (EXTRACTION_DRIVER=fake, set in scripts/e2e-session.mjs childEnv): it scans the
// transcript newest-first for the first CLIENT utterance whose body has a line
// starting `EXTRACT:`, then JSON-parses the rest of that line as a
// Partial<ExtractionResult>. So an inbound SMS whose body is `EXTRACT:` + the
// JSON payload drives EXACTLY the extraction result the test wants - no LLM.

/** The result of a dev extraction tick: how many due conversations ran / failed. */
export interface ExtractionTickResult {
  processed: number;
  failed: number;
}

/**
 * Run ONE synchronous extraction pass via the hermetic-only dev seam
 * (POST /__dev/extraction/tick, proxied to the app through the dashboard dev
 * server - same relative-path convention as `reseed`). The route jumps its clock
 * to `now + debounce + 1s`, so a due item scheduled by an inbound moments earlier
 * is already past its sliding dueAt: the test never waits out the real debounce.
 * Returns the app's `{ processed, failed }` counts.
 */
export async function extractionTick(request: APIRequestContext): Promise<ExtractionTickResult> {
  const res = await request.post('/__dev/extraction/tick');
  if (!res.ok()) throw new Error(`/__dev/extraction/tick failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as ExtractionTickResult;
}

let extractSeq = 0;
/** A per-call-unique inbound MessageSid so the webhook's SID-dedupe never drops
 *  (or collapses) two EXTRACT texts - the debounce-slide scenario sends two. */
function uniqueExtractSid(): string {
  extractSeq += 1;
  return `SMx${Date.now()}${extractSeq}`;
}

/**
 * Drive the fake extraction driver: POST a REAL-signed inbound SMS whose body is
 * `EXTRACT:` + `JSON.stringify(payload)` from `phone` (via fakeTwilio's
 * `postInboundSms`, which posts straight to the app webhook - no persona
 * registration needed). The inbound persists as a CLIENT utterance and schedules a
 * sliding extraction; the next `extractionTick` applies it. `payload` is a
 * Partial<ExtractionResult> (e.g. `{ fields: { pets: { op: 'write', value: 'yes' } } }`).
 * Throws on any non-200 webhook ack.
 */
export async function sendExtractSms(
  request: APIRequestContext,
  phone: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = `EXTRACT:${JSON.stringify(payload)}`;
  const { status, body: respBody } = await postInboundSms(request, {
    from: phone,
    body,
    messageSid: uniqueExtractSid(),
  });
  if (status !== 200) throw new Error(`sendExtractSms webhook rejected: ${status} ${respBody}`);
}
