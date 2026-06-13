// Pure presentation helpers for the inbox rows. Kept side-effect-free so they
// can be unit-tested in isolation (formatters.test.ts).
import type { ConversationSummary } from '../../api/index.js';

/**
 * Format an E.164 (or near-E.164) phone for display. US/NANP numbers render as
 * "(415) 555-0142"; "+1" is dropped for readability. Anything we can't confidently
 * parse is returned unchanged (never fabricated). Falsy input yields "Unknown
 * number" rather than an empty string.
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return 'Unknown number';
  const trimmed = raw.trim();
  // Strip everything but leading + and digits.
  const digits = trimmed.replace(/[^\d+]/g, '');
  // NANP: optional +1 then 10 digits.
  const nanp = /^\+?1?(\d{3})(\d{3})(\d{4})$/.exec(digits);
  if (nanp) {
    return `(${nanp[1]}) ${nanp[2]}-${nanp[3]}`;
  }
  return trimmed;
}

/**
 * A compact relative timestamp ("now", "2m", "3h", "yesterday", "4d", or a
 * locale date for anything older than a week). `now` is injectable for tests.
 * Invalid/empty input returns an empty string.
 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso);
  const ms = then.getTime();
  if (Number.isNaN(ms)) return '';

  const diffMs = now.getTime() - ms;
  // Future timestamps (clock skew) collapse to "now".
  if (diffMs < 0) return 'now';

  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  if (sec < 45) return 'now';
  if (min < 60) return `${Math.max(1, min)}m`;
  if (hr < 24) return `${hr}h`;
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d`;
  return then.toLocaleDateString();
}

/**
 * The honest display name for a conversation row. The backend now denormalizes
 * the resolved contact name onto the summary as `participant_display_name`; we
 * prefer it when present, else fall back to the formatted participant phone. We
 * NEVER fabricate a person's name (an un-triaged participant has a null name and
 * shows their phone).
 */
export function displayName(c: ConversationSummary): string {
  if (c.participant_display_name !== null && c.participant_display_name.length > 0) {
    return c.participant_display_name;
  }
  return formatPhone(c.participant_phone ?? c.participants[0]?.phone);
}

/**
 * Whether to show the honest-identity "needs review" triage chip. A row needs
 * review when the thread is still `unknown_1to1` AND no resolved name has been
 * denormalized onto it. The name guard matters because a pm/team_member contact
 * never flips the thread type (there is no `*_1to1` value for them) — yet once
 * triaged+named the backend writes `participant_display_name`, so the row is
 * resolved and should drop the chip. Both signals ride the inbox's single
 * DynamoDB query + the live conversation.updated event (no per-row contact
 * fetch — review boundary H3).
 */
export function needsReview(c: ConversationSummary): boolean {
  return c.type === 'unknown_1to1' && !c.participant_display_name;
}

/** True for a relay-group inbox row (M1.7). */
export function isRelayGroup(c: ConversationSummary): boolean {
  return c.type === 'relay_group';
}

/** Member count for a relay-group row (the roster length; 0 when none). */
export function relayMemberCount(c: ConversationSummary): number {
  return c.participants?.length ?? 0;
}
