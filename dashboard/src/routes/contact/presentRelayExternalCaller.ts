import type { TimelineCall } from '../../api/types.js';
import { formatPhone } from './format.js';

export interface RelayExternalCallerPresentation {
  summary: string;
  phoneLabel: string;
  linkedContactId?: string;
}

/** Presents persisted non-member caller facts without consulting the current
 * roster or matching a phone number at read time. */
export function presentRelayExternalCaller(
  call: TimelineCall,
): RelayExternalCallerPresentation | undefined {
  if (call.relay_refusal_reason !== 'non_member') return undefined;

  const contactId = call.relay_external_caller_contact_id?.trim();
  const displayName = call.relay_external_caller_display_name?.trim();
  const phone = call.relay_external_caller_phone?.trim();
  const phoneLabel = phone === undefined || phone === '' ? 'Caller ID unavailable' : formatPhone(phone);

  if (contactId !== undefined && contactId !== '' && displayName !== undefined && displayName !== '') {
    return {
      summary: `${displayName} tried to call this relay number`,
      phoneLabel,
      linkedContactId: contactId,
    };
  }

  if (phone !== undefined && phone !== '') {
    return {
      summary: `${phoneLabel} tried to call this relay number`,
      phoneLabel,
    };
  }

  return {
    summary: 'An unknown caller tried to call this relay number',
    phoneLabel,
  };
}
