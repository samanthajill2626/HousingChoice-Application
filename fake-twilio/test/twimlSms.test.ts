// The SMS-reply TwiML parser (docs/issues/fake-phones-no-twiml-replies.md),
// plus the engine-level proof that a webhook's <Message> reply really lands on
// the sender's fake phone - the half of every keyword flow QA could not see.
import { describe, expect, it } from 'vitest';

import { FakeTwilioEngine } from '../src/engine/engine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import { parseTwimlMessages } from '../src/engine/twimlSms.js';

describe('parseTwimlMessages', () => {
  it('parses the inline-text shape the app keyword replies use', () => {
    expect(
      parseTwimlMessages('<?xml version="1.0"?><Response><Message>You are opted out. Reply START to resume.</Message></Response>'),
    ).toEqual([{ body: 'You are opted out. Reply START to resume.' }]);
  });

  it('parses nested Body + Media verbs', () => {
    expect(
      parseTwimlMessages(
        '<Response><Message><Body>flyer attached</Body><Media>https://x.test/a.jpg</Media></Message></Response>',
      ),
    ).toEqual([{ body: 'flyer attached', mediaUrls: ['https://x.test/a.jpg'] }]);
  });

  it('parses multiple Message verbs in order and unescapes entities', () => {
    expect(
      parseTwimlMessages('<Response><Message>first &amp; foremost</Message><Message>second &#x2713;</Message></Response>'),
    ).toEqual([{ body: 'first & foremost' }, { body: 'second ✓' }]);
  });

  it('yields nothing for empty TwiML, non-XML, and empty Message verbs', () => {
    expect(parseTwimlMessages('<Response/>')).toEqual([]);
    expect(parseTwimlMessages('')).toEqual([]);
    expect(parseTwimlMessages('OK')).toEqual([]);
    expect(parseTwimlMessages('<Response><Message></Message></Response>')).toEqual([]);
  });

  it('ignores attributes rather than honoring overrides the app never sends', () => {
    expect(
      parseTwimlMessages('<Response><Message to="+15550009999">still to the sender</Message></Response>'),
    ).toEqual([{ body: 'still to the sender' }]);
  });
});

describe('engine renders webhook TwiML replies onto the fake phone', () => {
  const APP_NUMBER = '+15550110001';
  const PARTY = '+15550170001';

  function makeEngine(webhookBody: string) {
    const hub = new EventHub();
    const engine = new FakeTwilioEngine({
      clock: new ManualClock('2026-06-16T00:00:00.000Z'),
      hub,
      appNumber: APP_NUMBER,
      dispatcher: {
        post: async () => 200,
        postForResponse: async () => ({ status: 200, body: webhookBody }),
      },
    });
    engine.addAdHoc({ label: 'Tessa', role: 'tenant', number: PARTY });
    return engine;
  }

  it('a keyword send comes back with the confirmation on the SAME thread', async () => {
    const engine = makeEngine(
      '<?xml version="1.0"?><Response><Message>You are opted out. Reply START to resume.</Message></Response>',
    );
    await engine.sendAsParty({ from: PARTY, body: 'STOP' });

    const thread = engine.listThreads().find((t) => t.partyNumber === PARTY);
    expect(thread, 'party thread exists').toBeDefined();
    const bodies = thread!.messages.map((m) => `${m.direction}:${m.body ?? ''}`);
    expect(bodies).toEqual([
      'inbound:STOP',
      'outbound:You are opted out. Reply START to resume.',
    ]);
    // Reply addressing is Twilio's default: to the sender, from the number
    // they texted.
    const reply = thread!.messages[1]!;
    expect(reply.from).toBe(APP_NUMBER);
    expect(reply.to).toBe(PARTY);
  });

  it('an empty TwiML response renders nothing (the common non-keyword case)', async () => {
    const engine = makeEngine('<?xml version="1.0"?><Response/>');
    await engine.sendAsParty({ from: PARTY, body: 'hello' });
    const thread = engine.listThreads().find((t) => t.partyNumber === PARTY);
    expect(thread!.messages).toHaveLength(1);
  });

  it('a status-only dispatcher (no postForResponse) still works, replies simply unrendered', async () => {
    const hub = new EventHub();
    const engine = new FakeTwilioEngine({
      clock: new ManualClock('2026-06-16T00:00:00.000Z'),
      hub,
      appNumber: APP_NUMBER,
      dispatcher: { post: async () => 200 },
    });
    engine.addAdHoc({ label: 'Tessa', role: 'tenant', number: PARTY });
    await engine.sendAsParty({ from: PARTY, body: 'STOP' });
    const thread = engine.listThreads().find((t) => t.partyNumber === PARTY);
    expect(thread!.messages).toHaveLength(1);
  });
});
