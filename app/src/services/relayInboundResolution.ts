// Shared relay inbound resolution (relay-number-lifecycle). A pool number
// fronts MANY participant-disjoint relay groups, concurrently and over time
// (pool_number is never cleared), so EVERY inbound on a pool number - SMS and
// voice alike - must resolve its group on the (To, From) PAIR, never on To
// alone. This module is the ONE copy of that ladder; the 2026-08-22/23 prod
// incident (five legitimate calls refused across three groups) was the cost of
// the voice webhook carrying its own To-only variant. Terminal ACTIONS stay
// per-channel (fan-out / 1:1 intercept for SMS, bridge / masked refusal for
// voice); only the selection POLICY lives here. Precedent: ourNumberKind.ts,
// extracted for the same cannot-drift reason.
//
// The ladder (mirrors the shapes adjudicated in the SMS webhook):
//   (a) open_member    - an OPEN group whose roster contains the sender. The
//       burn invariant (poolNumbersRepo.burnClaim, enforced atomically at
//       write time) guarantees at most one; a corrupt-many resolves to the
//       newest and surfaces the colliding ids for the caller to log as an
//       error (never a crash).
//   (b) closed_member  - else the sender's newest CLOSED group ("newest of
//       several - a person can be in several closed groups on one number over
//       the years").
//   (c) non_member_open - else, sender on NO roster but an OPEN group exists:
//       the newest open group, for the record.
//   (d) all_closed_non_member - else (every group closed, sender on no
//       roster): NO group. AF-5: do not bury the contact in a dead group
//       transcript - it could hide a real message or call from a stranger, a
//       second phone, or a member from a NEW phone. Each channel falls
//       through to its own intake path (SMS: the 1:1 path; voice: founder
//       call-triage).
//
// Membership is the raw `participant.phone === from` walk, deliberately
// unnormalized on both sides of the comparison - the SMS path has always
// matched this way, and From is a Twilio-normalized E.164 already.
import type { ConversationItem } from '../repos/conversationsRepo.js';

/**
 * Newest-first by created_at. A missing created_at maps to '' and therefore
 * sorts LAST - deliberate: an undated legacy/imported row must never win a
 * "newest" pick over a dated one. Ties (same millisecond, or two undated rows)
 * keep the input order, which for the real repo is raw GSI page order - callers
 * accept that residual nondeterminism the same way the SMS path always has.
 */
export function byNewestCreated(a: ConversationItem, b: ConversationItem): number {
  const aC = a.created_at ?? '';
  const bC = b.created_at ?? '';
  return aC < bC ? 1 : aC > bC ? -1 : 0;
}

export type RelayInboundResolution =
  | {
      kind: 'open_member';
      group: ConversationItem;
      /**
       * Set ONLY when the burn invariant is violated (2+ open groups on one
       * number carry the sender): every colliding conversationId, newest
       * first. The caller must log these at error level so ops can repair the
       * data; the resolution itself already routed to the newest.
       */
      violatingOpenMatchIds?: string[];
    }
  | { kind: 'closed_member'; group: ConversationItem }
  | { kind: 'non_member_open'; group: ConversationItem }
  | { kind: 'all_closed_non_member' };

/**
 * Resolve which of a pool number's groups an inbound from `from` belongs to.
 * Returns undefined when `groups` is empty (the number fronts no relay groups
 * at all - the caller's To is not really a pool number).
 */
export function resolveRelayInbound(
  groups: ConversationItem[],
  from: string,
): RelayInboundResolution | undefined {
  if (groups.length === 0) return undefined;
  const isMember = (g: ConversationItem): boolean =>
    (g.participants ?? []).some((m) => m.phone === from);

  const openMatches = groups.filter((g) => g.status === 'open' && isMember(g)).sort(byNewestCreated);
  if (openMatches[0]) {
    return {
      kind: 'open_member',
      group: openMatches[0],
      ...(openMatches.length > 1 && {
        violatingOpenMatchIds: openMatches.map((g) => g.conversationId),
      }),
    };
  }

  const closedMatch = groups
    .filter((g) => g.status !== 'open' && isMember(g))
    .sort(byNewestCreated)[0];
  if (closedMatch) return { kind: 'closed_member', group: closedMatch };

  const openFallback = groups.filter((g) => g.status === 'open').sort(byNewestCreated)[0];
  if (openFallback) return { kind: 'non_member_open', group: openFallback };

  return { kind: 'all_closed_non_member' };
}
