// Shared helpers for the AI-suggestion review UI (AutoBadge + SuggestionChip),
// used by TenantFile, EligibilityIntakeCard, and UnknownFile. Human labels for a
// suggestion `target` (forms the chip's accessible name `AI suggestion for
// <label>`; 'status' MUST stay exactly "status" - e2e depends on it) and a reader
// for a contact field's `<field>_source` AI provenance stamp.
import type { Contact, FieldSource, SuggestionItem } from '../../api/index.js';

/** Display label per suggestion target. */
export const SUGGESTION_TARGET_LABEL: Record<string, string> = {
  firstName: 'first name',
  lastName: 'last name',
  voucherSize: 'voucher size',
  housingAuthority: 'housing authority',
  pets: 'pets',
  evictions: 'evictions',
  tenure: 'time at current address',
  porting: 'porting',
  status: 'status',
  phone: 'phone',
  type: 'type',
};

/** The AI provenance stamp for a field, when its value came from an extraction. */
export function aiSourceOf(contact: Contact, field: string): FieldSource | undefined {
  const raw = contact[`${field}_source`];
  if (raw !== null && typeof raw === 'object' && (raw as FieldSource).source === 'ai') {
    return raw as FieldSource;
  }
  return undefined;
}

/** The pending suggestion for a target, if any (server is authoritative). */
export function suggestionFor(
  suggestions: SuggestionItem[],
  target: string,
): SuggestionItem | undefined {
  return suggestions.find((s) => s.target === target);
}
