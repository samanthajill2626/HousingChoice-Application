// retry-send-window D3a step 2: previewSendRefusal, the PURE preview of the
// one-to-one send wrapper's refusals. The rows live in ONE table
// (helpers/sendRefusalCases.ts) that the parity test in sendMessage.test.ts
// also runs through the REAL wrapper, so green here plus green there means the
// preview and the send path agree on every row.
import { describe, expect, it } from 'vitest';
import { previewSendRefusal, type SendRefusalCode } from '../src/services/sendRefusalPreview.js';
import { LIVE_CONTACT, SEND_REFUSAL_CASES, SEND_REFUSAL_PHONE } from './helpers/sendRefusalCases.js';

describe('previewSendRefusal (retry-send-window D3a step 2)', () => {
  it.each(SEND_REFUSAL_CASES)('$name', (c) => {
    expect(
      previewSendRefusal({
        smsSendingEnabled: c.smsSendingEnabled,
        conversation: c.conversation,
        phoneContact: c.phoneContact,
        recipient: c.recipient,
        participantPhone: SEND_REFUSAL_PHONE,
        automated: c.automated,
      }),
    ).toBe(c.expected);
  });

  it('treats an UNSET kill switch as enabled (explicit false only, like sendMessage)', () => {
    expect(
      previewSendRefusal({
        smsSendingEnabled: undefined,
        conversation: { ai_mode: 'auto' },
        phoneContact: LIVE_CONTACT,
        recipient: undefined,
        participantPhone: SEND_REFUSAL_PHONE,
        automated: true,
      }),
    ).toBeUndefined();
  });

  it('the table exercises every refusal code AND the sent outcome', () => {
    const all: (SendRefusalCode | 'sent')[] = [
      'contact_deleted',
      'contact_no_consent',
      'contact_opted_out',
      'manual_mode',
      'sent',
      'sms_sending_disabled',
    ];
    expect([...new Set(SEND_REFUSAL_CASES.map((c) => c.expected ?? 'sent'))].sort()).toEqual(all);
  });
});
