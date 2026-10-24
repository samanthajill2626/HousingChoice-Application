// Quiet shares (spec docs/superpowers/specs/2026-10-23-today-checklist-design.md
// section 6, plan PR23): the Today section listing people a property was sent
// to who have gone quiet. PURE - routes/today.ts supplies the Follow up core's
// waiting rows (services/followUps.ts collectWaitingFollowUps) and the clock.
//
// The rule (spec 6.1): quietSince is the latest of the share's sentAt, the
// recipient's last_heard_from_at and its last_reached_out_at - each only when
// later, and an unparseable value is ignored. A row is shown when
// now - quietSince >= 48h (outcome replied) or 120h (outcome no_reply): fixed
// durations, not calendar days, like the tab's 24h and 14-day constants. The
// state is the outcome; staff outreach restarts the clock but never changes
// the state.
//
// Each row keeps its OWN clock from its own sentAt. Shares never move
// last_reached_out_at (spec 7.2), so sending someone another property does not
// restart the properties they were sent before.
//
// SUBSET, by construction: every row shown here is also a Follow up tab row -
// the candidates ARE the tab's waiting rows, both thresholds exceed the tab's
// 24h, and this clock is never earlier than the tab's waitingSince. Nobody
// should "fix" Today to show rows the tab does not.
import type { QuietShareProperty, QuietSharePerson } from '../routes/today.js';
import type { WaitingFollowUp } from './followUps.js';

/** Replied, then quiet this long (spec 6.1: 2 days, a fixed duration). */
export const QUIET_REPLIED_MS = 48 * 60 * 60 * 1000;
/** Never replied in this long (spec 6.1: 5 days, a fixed duration). */
export const QUIET_NO_REPLY_MS = 120 * 60 * 60 * 1000;

/** Epoch ms of an ISO string; undefined when absent or unparseable. */
function instantMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Ordinal string order - deterministic, locale-free tie-breaks. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inside a property, replied people sort before no_reply ones (spec 6.2). */
const STATE_RANK: Record<QuietSharePerson['state'], number> = { replied: 0, no_reply: 1 };

interface ListedPerson {
  person: QuietSharePerson;
  quietMs: number;
}

/**
 * The Quiet shares section from the Follow up core's waiting rows (spec 6):
 * the properties in order (by their longest-quiet person, oldest first; ties
 * by unitId), each with its people in order (replied, then no_reply; within
 * each the oldest quietSince first; ties by contactId). A person waiting on
 * two properties has a row under each. No distinct-people count is built:
 * section headings carry no count (spec r8 2.1, plan PR102, PR103).
 */
export function buildQuietShares(
  rows: readonly WaitingFollowUp[],
  now: number,
): { properties: QuietShareProperty[] } {
  const byUnit = new Map<string, { unitId: string; unitLabel: string; people: ListedPerson[] }>();
  for (const { item, recipient } of rows) {
    const state = item.outcome;
    // The core already keeps only these two; the builder does not rely on it.
    if (state !== 'replied' && state !== 'no_reply') continue;
    const sentMs = instantMs(item.sentAt);
    if (sentMs === undefined) continue;
    let quietMs = sentMs;
    for (const later of [instantMs(recipient.last_heard_from_at), instantMs(recipient.last_reached_out_at)]) {
      if (later !== undefined && later > quietMs) quietMs = later;
    }
    const threshold = state === 'replied' ? QUIET_REPLIED_MS : QUIET_NO_REPLY_MS;
    if (now - quietMs < threshold) continue;
    let group = byUnit.get(item.unitId);
    if (group === undefined) {
      group = { unitId: item.unitId, unitLabel: item.unitLabel, people: [] };
      byUnit.set(item.unitId, group);
    }
    group.people.push({
      person: {
        contactId: item.contactId,
        name: item.name,
        type: item.type,
        ...(item.role !== undefined && { role: item.role }),
        state,
        quietSince: new Date(quietMs).toISOString(),
      },
      quietMs,
    });
  }

  const groups = [...byUnit.values()];
  for (const group of groups) {
    group.people.sort(
      (a, b) =>
        STATE_RANK[a.person.state] - STATE_RANK[b.person.state] ||
        a.quietMs - b.quietMs ||
        compareIds(a.person.contactId, b.person.contactId),
    );
  }
  const oldestQuiet = (group: { people: ListedPerson[] }): number =>
    Math.min(...group.people.map((p) => p.quietMs));
  groups.sort((a, b) => oldestQuiet(a) - oldestQuiet(b) || compareIds(a.unitId, b.unitId));

  return {
    properties: groups.map((group) => ({
      unitId: group.unitId,
      unitLabel: group.unitLabel,
      people: group.people.map((p) => p.person),
    })),
  };
}
