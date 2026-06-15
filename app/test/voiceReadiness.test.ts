// Boot readiness signal for founder call-triage (M1.9b). Creating the voice
// router logs, ONCE at startup, whether triage can actually bridge: it needs
// BOTH a business number (the founder-leg caller ID = OUR_PHONE_NUMBERS[0]) and
// a founder cell to dial. Missing either makes every inbound business call
// degrade to the "text us" fallback — so the line must say DISABLED loudly
// rather than letting a missing/unpushed FOUNDER_CELL surface only on a live
// test call (the FOUNDER_CELL-not-in-SSM bug, 2026-06-15). PII: booleans only,
// never the cell value.
import { describe, expect, it } from 'vitest';
import { createTwilioVoiceRouter } from '../src/routes/webhooks/voice.js';
import { newBootId, runWithContext } from '../src/lib/context.js';
import { createLogger, isOrphanLogLine } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness } from './helpers/twilioWebhookHarness.js';

const FOUNDER_CELL = '+15550160000';

/** Build the voice router with the given env and return its boot readiness line. */
function readinessLine(env: Record<string, string>) {
  const { config } = makeWebhookHarness({ world: createFakeWorld(), env });
  const capture = createLogCapture();
  const logger = createLogger({ level: 'info', destination: capture.stream });
  createTwilioVoiceRouter({ config, logger });
  const line = capture.lines.find((l) =>
    String(l['msg']).startsWith('voice: founder call-triage'),
  );
  expect(line, 'expected a founder call-triage readiness log line at router creation').toBeDefined();
  return line!;
}

describe('voice: founder call-triage boot readiness log', () => {
  it('logs ENABLED when OUR_PHONE_NUMBERS[0] + FOUNDER_CELL are both set', () => {
    const line = readinessLine({ FOUNDER_CELL });
    expect(line['founderTriage']).toBe('enabled');
    expect(line['hasBusinessNumber']).toBe(true);
    expect(line['hasFounderCell']).toBe(true);
    expect(String(line['msg'])).toContain('ENABLED');
  });

  it('logs DISABLED (the symptom) when FOUNDER_CELL is unset', () => {
    const line = readinessLine({}); // harness still sets OUR_PHONE_NUMBERS by default
    expect(line['founderTriage']).toBe('disabled');
    expect(line['hasBusinessNumber']).toBe(true);
    expect(line['hasFounderCell']).toBe(false);
    expect(String(line['msg'])).toContain('DISABLED');
  });

  it('never logs the founder cell value (PII)', () => {
    const { config } = makeWebhookHarness({ world: createFakeWorld(), env: { FOUNDER_CELL } });
    const capture = createLogCapture();
    createTwilioVoiceRouter({ config, logger: createLogger({ level: 'info', destination: capture.stream }) });
    expect(JSON.stringify(capture.lines)).not.toContain(FOUNDER_CELL);
  });

  it('is correlation-safe inside a boot context — carries a correlationId, not an orphan log', () => {
    // index.ts builds the app inside runWithContext(bootContext); this is the
    // router-level proof that the readiness line then carries the bootId as its
    // correlationId, so it never trips hc-<env>-orphan-logs (binding guideline
    // #4). Regression guard for the 2026-06-15 orphan-log alarm.
    const { config } = makeWebhookHarness({ world: createFakeWorld(), env: { FOUNDER_CELL } });
    const capture = createLogCapture();
    const logger = createLogger({ level: 'info', destination: capture.stream });
    runWithContext({ bootId: newBootId() }, () => {
      createTwilioVoiceRouter({ config, logger });
    });
    const line = capture.lines.find((l) =>
      String(l['msg']).startsWith('voice: founder call-triage'),
    );
    expect(line).toBeDefined();
    expect(typeof line!['correlationId']).toBe('string');
    expect(isOrphanLogLine(line!)).toBe(false);
  });
});
