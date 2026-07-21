// fake-twilio/test/mailEngine.test.ts
//
// Unit tests for the fake-SES MailEngine's dumb string-scan MIME parsing (ADJ-10:
// no mailparser) + the shared-hub emit. Covers header folding, addr-spec extraction
// from `Name <addr>` forms, multi-address Cc, that body/part headers do NOT leak
// into the top-level scan, newest-first listing, reset, and the mail.outbound event.
import { describe, expect, it } from 'vitest';
import { MailEngine } from '../src/engine/mailEngine.js';
import { EventHub } from '../src/engine/eventHub.js';
import type { EngineEvent } from '../src/engine/engineEvents.js';

function b64(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64');
}

function makeEngine() {
  const events: EngineEvent[] = [];
  const hub = new EventHub();
  hub.subscribe((e) => events.push(e));
  return { engine: new MailEngine({ hub }), events };
}

describe('MailEngine.recordOutbound', () => {
  it('extracts addr-specs from Name <addr> forms and mints ses-fake-<n>', () => {
    const { engine } = makeEngine();
    const rec = engine.recordOutbound(
      b64(
        [
          'To: Marcus Bell <marcus.bell@example.com>',
          'Subject: Welcome',
          'Message-ID: <hc-1@mail.local.test>',
          '',
          'body',
        ].join('\r\n'),
      ),
    );
    expect(rec.sesMessageId).toBe('ses-fake-1');
    expect(rec.to).toEqual(['marcus.bell@example.com']);
    expect(rec.subject).toBe('Welcome');
    expect(rec.messageIdHeader).toBe('<hc-1@mail.local.test>');
    expect(rec.state).toBe('sent');
  });

  it('unfolds a header folded across continuation lines (RFC 5322 WSP folding)', () => {
    const { engine } = makeEngine();
    const rec = engine.recordOutbound(
      b64(
        [
          'To: Marcus Bell <marcus.bell@example.com>,',
          '  assistant@example.com',
          'Subject: Folded',
          '',
          'body',
        ].join('\r\n'),
      ),
    );
    expect(rec.to).toEqual(['marcus.bell@example.com', 'assistant@example.com']);
  });

  it('comma-splits multi-address Cc and drops empties', () => {
    const { engine } = makeEngine();
    const rec = engine.recordOutbound(
      b64(['To: a@example.com', 'Cc: b@example.com, , c@example.com', '', 'body'].join('\r\n')),
    );
    expect(rec.cc).toEqual(['b@example.com', 'c@example.com']);
  });

  it('does NOT scan body / MIME-part headers as top-level headers', () => {
    const { engine } = makeEngine();
    // The attachment part has its own `Subject:`-shaped noise + a Content-Type; the
    // top-level Subject must win and the part Content-Type must not become a header.
    const rec = engine.recordOutbound(
      b64(
        [
          'To: a@example.com',
          'Subject: Real',
          'Content-Type: multipart/mixed; boundary="B"',
          '',
          '--B',
          'Content-Type: image/png',
          '',
          'Subject: Fake',
          '--B--',
        ].join('\r\n'),
      ),
    );
    expect(rec.subject).toBe('Real');
    // The raw MIME is still retained whole (the attachment part is observable).
    expect(rec.rawMime).toContain('Content-Type: image/png');
  });

  it('defaults subject to empty and omits messageIdHeader when absent', () => {
    const { engine } = makeEngine();
    const rec = engine.recordOutbound(b64(['To: a@example.com', '', 'body'].join('\r\n')));
    expect(rec.subject).toBe('');
    expect(rec.messageIdHeader).toBeUndefined();
    expect(rec.cc).toEqual([]);
  });

  it('emits a mail.outbound hub event carrying the stored record', () => {
    const { engine, events } = makeEngine();
    const rec = engine.recordOutbound(b64(['To: a@example.com', 'Subject: Hi', '', 'b'].join('\r\n')));
    const ev = events.find((e) => e.type === 'mail.outbound');
    expect(ev).toBeDefined();
    if (ev?.type === 'mail.outbound') {
      expect(ev.mail.sesMessageId).toBe(rec.sesMessageId);
      expect(ev.mail.subject).toBe('Hi');
    }
  });

  it('lists newest-first and clears on reset', () => {
    const { engine } = makeEngine();
    engine.recordOutbound(b64(['To: a@example.com', 'Subject: One', '', 'b'].join('\r\n')));
    engine.recordOutbound(b64(['To: a@example.com', 'Subject: Two', '', 'b'].join('\r\n')));
    expect(engine.list().map((e) => e.subject)).toEqual(['Two', 'One']);
    engine.reset();
    expect(engine.list()).toHaveLength(0);
  });
});
