// Boot readiness signal for inbound call-triage (M1.9b / Voice Phase 1). Creating
// the voice router logs, ONCE at startup, whether the business number used as the
// founder-leg caller ID (OUR_PHONE_NUMBERS[0]) is configured. The inbound-voice-line
// HOLDER (whose verified cell is dialed) is RUNTIME DATA (a user record), not boot
// config, so it can't be asserted at startup — only the business number is. Missing
// it makes every inbound business call degrade to the "text us" fallback, so the
// line must say so loudly rather than surfacing only on a live test call. PII:
// booleans only, never a cell value.
import { describe, expect, it } from 'vitest';
import { createTwilioVoiceRouter } from '../src/routes/webhooks/voice.js';
import { newBootId, runWithContext } from '../src/lib/context.js';
import { createLogger, isOrphanLogLine } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness } from './helpers/twilioWebhookHarness.js';

/** Build the voice router with the given env and return its boot readiness line. */
function readinessLine(env: Record<string, string>) {
  const { config } = makeWebhookHarness({ world: createFakeWorld(), env });
  const capture = createLogCapture();
  const logger = createLogger({ level: 'info', destination: capture.stream });
  createTwilioVoiceRouter({ config, logger });
  const line = capture.lines.find((l) =>
    String(l['msg']).startsWith('voice: business number'),
  );
  expect(line, 'expected a voice business-number readiness log line at router creation').toBeDefined();
  return line!;
}

describe('voice: inbound call-triage boot readiness log', () => {
  it('logs the business number as configured when OUR_PHONE_NUMBERS[0] is set', () => {
    const line = readinessLine({}); // harness sets OUR_PHONE_NUMBERS by default
    expect(line['hasBusinessNumber']).toBe(true);
    expect(String(line['msg'])).toContain('configured');
    // Names where inbound routing gets its target: the holder's verified cell.
    expect(String(line['msg'])).toContain('inbound-voice-line holder');
  });

  it('logs the business number as NOT configured when OUR_PHONE_NUMBERS is empty', () => {
    const line = readinessLine({ OUR_PHONE_NUMBERS: '' });
    expect(line['hasBusinessNumber']).toBe(false);
    expect(String(line['msg'])).toContain('NOT configured');
  });

  it('never logs a phone number (PII) — booleans only', () => {
    const { config } = makeWebhookHarness({ world: createFakeWorld(), env: {} });
    expect(config.ourPhoneNumbers.length).toBeGreaterThan(0); // the default harness number
    const capture = createLogCapture();
    createTwilioVoiceRouter({ config, logger: createLogger({ level: 'info', destination: capture.stream }) });
    // The readiness line reports a BOOLEAN, never the business number itself.
    for (const num of config.ourPhoneNumbers) {
      expect(JSON.stringify(capture.lines)).not.toContain(num);
    }
  });

  it('is correlation-safe inside a boot context — carries a correlationId, not an orphan log', () => {
    // index.ts builds the app inside runWithContext(bootContext); this is the
    // router-level proof that the readiness line then carries the bootId as its
    // correlationId, so it never trips hc-<env>-orphan-logs (binding guideline
    // #4). Regression guard for the 2026-06-15 orphan-log alarm.
    const { config } = makeWebhookHarness({ world: createFakeWorld(), env: {} });
    const capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    runWithContext({ bootId: newBootId() }, () => {
      createTwilioVoiceRouter({ config, logger });
    });
    const line = capture.lines.find((l) =>
      String(l['msg']).startsWith('voice: business number'),
    );
    expect(line).toBeDefined();
    expect(typeof line!['correlationId']).toBe('string');
    expect(isOrphanLogLine(line!)).toBe(false);
  });
});
