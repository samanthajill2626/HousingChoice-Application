import { describe, expect, it } from 'vitest';
import type { TimelineCall } from '../../api/types.js';
import { presentRelayExternalCaller } from './presentRelayExternalCaller.js';

function nonMemberCall(fields: Partial<TimelineCall> = {}): TimelineCall {
  return {
    kind: 'call',
    id: 'call-1',
    at: '2026-08-28T12:21:16.000Z',
    direction: 'inbound',
    relay_refusal_reason: 'non_member',
    ...fields,
  };
}

describe('presentRelayExternalCaller', () => {
  it('uses a hydrated name only when the call stored a contact ID', () => {
    expect(
      presentRelayExternalCaller(
        nonMemberCall({
          relay_external_caller_contact_id: 'contact-external',
          relay_external_caller_display_name: '  Morgan Lee  ',
          relay_external_caller_phone: '+16175550198',
        }),
      ),
    ).toEqual({
      summary: 'Morgan Lee tried to call this relay number',
      phoneLabel: '(617) 555-0198',
      linkedContactId: 'contact-external',
    });
  });

  it('falls back to the stored phone without using a display name that has no stored contact ID', () => {
    expect(
      presentRelayExternalCaller(
        nonMemberCall({
          relay_external_caller_display_name: 'Morgan Lee',
          relay_external_caller_phone: '+16175550198',
        }),
      ),
    ).toEqual({
      summary: '(617) 555-0198 tried to call this relay number',
      phoneLabel: '(617) 555-0198',
    });
  });

  it('does not treat a blank stored contact ID as a linkable identity', () => {
    expect(
      presentRelayExternalCaller(
        nonMemberCall({
          relay_external_caller_contact_id: '   ',
          relay_external_caller_display_name: 'Morgan Lee',
          relay_external_caller_phone: '+16175550198',
        }),
      ),
    ).toEqual({
      summary: '(617) 555-0198 tried to call this relay number',
      phoneLabel: '(617) 555-0198',
    });
  });

  it('shows the unknown-caller fallback when caller ID was unavailable', () => {
    expect(presentRelayExternalCaller(nonMemberCall())).toEqual({
      summary: 'An unknown caller tried to call this relay number',
      phoneLabel: 'Caller ID unavailable',
    });
  });

  it('does not infer an external caller presentation from an ordinary call', () => {
    expect(
      presentRelayExternalCaller(
        nonMemberCall({ relay_refusal_reason: undefined, relay_external_caller_phone: '+16175550198' }),
      ),
    ).toBeUndefined();
  });
});
