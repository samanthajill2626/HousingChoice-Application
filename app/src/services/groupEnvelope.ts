// The carrier-group ENVELOPE (native group texting, spec 5.1 + 8.1).
//
// A carrier group text delivered to the business number arrives at the classic
// messaging webhook looking exactly like a 1:1 - except for one undocumented
// set of form params, `OtherRecipients{N}`, carrying the OTHER handsets on the
// thread. The live spike proved the indexed shape; the unindexed `OtherRecipients`
// singular is accepted defensively because the contract is undocumented and
// Twilio can change it without notice.
//
// This module only READS params. Identity (roster, conversationId, exclusions)
// is services/groupIdentity.ts; filing is the webhook. Keeping the parse here
// makes the shape unit-testable without an Express app.
//
// PII (doc 9): the values ARE phone numbers - data, never log output.

/**
 * The webhook's form params as this module sees them. `string[]` is possible:
 * express's `extended: false` (querystring) parser returns an ARRAY for a
 * repeated key, so a doubled `OtherRecipients=` would not be a string at all.
 */
export type GroupEnvelopeParams = Record<string, string | string[] | undefined>;

/**
 * Highest `OtherRecipients{N}` index inspected. Twilio caps a group MMS at 10
 * handsets, so 32 is generous headroom while keeping the scan a fixed, tiny
 * cost on EVERY inbound (invariant 13.2: the 1:1 path gains no I/O - this is
 * property reads on an already-parsed object).
 */
export const MAX_OTHER_RECIPIENTS_INDEX = 32;

/** One envelope value -> the trimmed non-empty strings it contributes. */
function collect(value: string | string[] | undefined, out: string[]): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length > 0) out.push(trimmed);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const entry of value) collect(entry, out);
}

/**
 * Every `OtherRecipients` address on this inbound, in envelope order.
 *
 * GAP-TOLERANT by construction: the scan never breaks on a missing index, so a
 * sparse `OtherRecipients0` + `OtherRecipients3` envelope yields BOTH members.
 * Breaking on the first hole would silently derive a smaller roster - and a
 * smaller roster is a DIFFERENT conversationId, i.e. a forked thread.
 *
 * Values are returned verbatim (trimmed only); normalization and exclusion are
 * groupIdentity's job.
 */
export function parseOtherRecipients(params: GroupEnvelopeParams): string[] {
  const out: string[] = [];
  collect(params['OtherRecipients'], out);
  for (let i = 0; i <= MAX_OTHER_RECIPIENTS_INDEX; i++) {
    collect(params[`OtherRecipients${i}`], out);
  }
  return out;
}

/** True when this inbound carries a group envelope at all (spec 5.2 vs 5.3). */
export function hasGroupEnvelope(params: GroupEnvelopeParams): boolean {
  return parseOtherRecipients(params).length > 0;
}

/**
 * The TRIPWIRE shape (spec 8.1): an `MM`-prefixed provider SID with NO media
 * and NO envelope. Twilio mints MM SIDs for group-addressed messages, so this
 * combination is what a SILENTLY REMOVED `OtherRecipients` contract would look
 * like from inside the webhook.
 *
 * Deliberately a heuristic, not a proof - a subject-only 1:1 MMS matches it too
 * - which is exactly why the caller files the message (fail open) and WARNs
 * rather than erroring.
 */
export function isMissingEnvelopeGroupShape(
  messageSid: string | undefined,
  params: GroupEnvelopeParams,
): boolean {
  if (typeof messageSid !== 'string' || !messageSid.startsWith('MM')) return false;
  const numMediaRaw = params['NumMedia'];
  const numMedia = typeof numMediaRaw === 'string' ? Number(numMediaRaw) || 0 : 0;
  if (numMedia > 0) return false;
  return !hasGroupEnvelope(params);
}
