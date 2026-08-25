// putSystemSidMarker at the WIRE level (log-hygiene spec section 5).
//
// WHY A WIRE-LEVEL SUITE: every other putSystemSidMarker test hit in this repo
// drives the harness FAKE (an in-memory Map in twilioWebhookHarness), so the
// REAL repo's PutCommand input is otherwise unasserted - and the TTL this task
// adds lives ONLY in that input. A doc client that records every command is the
// only place where the expires_at VALUE and, more importantly, its UNIT can be
// pinned: DynamoDB TTL silently ignores a non-numeric attribute, so an ISO
// string or a milliseconds value would look written and never reap.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { createMessagesRepo, type MessagesRepo } from '../src/repos/messagesRepo.js';
import { createLogCapture, type LogCapture } from './helpers/logCapture.js';

const SID = 'SMsyssid000000000000000000000001';
const DAY_SECONDS = 24 * 60 * 60;

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

/** A repo over a doc client that records every command and answers nothing. */
function markerRepo(): { repo: MessagesRepo; sent: Sent[]; capture: LogCapture } {
  const sent: Sent[] = [];
  const capture = createLogCapture();
  const doc = {
    async send(cmd: unknown): Promise<unknown> {
      const command = cmd as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ name: command.constructor.name, input: command.input });
      return {};
    },
  };
  const repo = createMessagesRepo({
    doc: doc as never,
    env: { TABLE_PREFIX: 'hc-unit-' },
    // level 'debug' EXPLICITLY: the default level drops debug lines before they
    // reach the destination, so a capture built without it would see an empty
    // array and the "downgraded to debug" case below would pass for the wrong
    // reason (nothing logged reads the same as nothing logged at info).
    logger: createLogger({ destination: capture.stream, level: 'debug' }),
  });
  return { repo, sent, capture };
}

function putItem(sent: Sent[]): Record<string, unknown> {
  const put = sent.find((s) => s.name === 'PutCommand');
  expect(put).toBeDefined();
  return put!.input['Item'] as Record<string, unknown>;
}

describe('putSystemSidMarker writes a 30-day TTL in epoch SECONDS', () => {
  it('expires_at is a NUMBER about 30 days out, in seconds', async () => {
    const { repo, sent } = markerRepo();
    const before = Math.floor(Date.now() / 1000);

    await repo.putSystemSidMarker(SID, 'relay.intro');

    const item = putItem(sent);
    const expiresAt = item['expires_at'];
    expect(typeof expiresAt).toBe('number');
    // A milliseconds value (the classic TTL bug) lands ~1.6 BILLION seconds
    // past this window, so the bound catches it as well as a wrong horizon.
    expect(expiresAt as number).toBeGreaterThanOrEqual(before + 29 * DAY_SECONDS);
    expect(expiresAt as number).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + 31 * DAY_SECONDS,
    );
  });

  it('keeps the marker key + payload the /status webhook reads', async () => {
    const { repo, sent } = markerRepo();

    await repo.putSystemSidMarker(SID, 'cell_verification');

    const item = putItem(sent);
    expect(item['conversationId']).toBe(`syssid#${SID}`);
    expect(item['tsMsgId']).toBe('ptr');
    expect(item['kind']).toBe('cell_verification');
    expect(typeof item['created_at']).toBe('string');
  });
});

describe('the per-marker write logs at debug, not info', () => {
  it('the marker line is emitted at debug level with no info twin', async () => {
    const { repo, capture } = markerRepo();

    await repo.putSystemSidMarker(SID, 'relay.intro');

    const markerLines = capture.lines.filter((l) => l['msg'] === 'system-send SID marker written');
    expect(markerLines).toHaveLength(1);
    // pino numeric levels: debug 20, info 30. The dev intro replay writes one
    // marker per member per boot - the fix must not trade N ERRORs for N INFOs.
    expect(markerLines[0]?.['level']).toBe(20);
    expect(capture.atLevel(30)).toEqual([]);
    expect(markerLines[0]?.['providerSid']).toBe(SID);
    expect(markerLines[0]?.['kind']).toBe('relay.intro');
  });
});
