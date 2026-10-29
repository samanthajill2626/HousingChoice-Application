// WP1 B2a (spec D2.3, D2.5; charter 6.3): the stored facts of ONE
// tenant-property pair - every counted send with its kind, the declined
// record, the tours (as the TOUR PROJECTION) and the days since the last send.
// Built from the stored listing_sends row and tours, NEVER from the derived
// outcome (lib/listingSendOutcome.ts), which flips on a new text or send and
// lets a re-send hide a decline the model must still see.
//
// tourProjection is the ONE place a tour becomes card facts: roster, reminder
// and bookkeeping fields change with no outcome, so they never reach a card, a
// pair history or a fingerprint.
import { FLYER_SHARE_KEY } from '../../lib/shareLedgerKeys.js';
import type { ListingSendItem } from '../../repos/listingSendsRepo.js';
import type { TourItem } from '../../repos/toursRepo.js';
import type { SeenHome } from './seenSet.js';
import type { PairHistory, SendFact, TourProjection } from './types.js';

export const DAY_MS = 86_400_000;

/** Epoch ms of a non-empty ISO string; undefined when absent or unparseable. */
export function instantMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function compareFacts(a: SendFact, b: SendFact): number {
  const byTime = (instantMs(a.at) ?? 0) - (instantMs(b.at) ?? 0);
  if (byTime !== 0) return byTime;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/**
 * Every counted send of the pair, oldest first: one fact per share entry whose
 * state is `counted` and that carries its instant - the `flyer` entry is the
 * tenant's own sign-up (`signed_up`), any other a send. A row whose shares
 * yield nothing (a legacy row with no share memory) falls back to `sentAt`.
 */
export function sendFactsOf(row: ListingSendItem): SendFact[] {
  const facts: SendFact[] = [];
  const shares = row.shares;
  if (shares !== undefined && shares !== null && typeof shares === 'object') {
    for (const [key, entry] of Object.entries(shares)) {
      if (entry.state !== 'counted' || typeof entry.countedAt !== 'string') continue;
      facts.push({ at: entry.countedAt, kind: key === FLYER_SHARE_KEY ? 'signed_up' : 'sent' });
    }
  }
  if (facts.length === 0 && typeof row.sentAt === 'string') facts.push({ at: row.sentAt, kind: 'sent' });
  return facts.sort(compareFacts);
}

/** The stored decline as `{ by, at }` (the staff id never leaves the row); null when none. */
export function declinedOf(row: ListingSendItem | undefined): { by: string; at: string } | null {
  const declined = row?.declined;
  if (declined === undefined || declined === null) return null;
  if (typeof declined.at !== 'string' || typeof declined.by !== 'string') return null;
  return { by: declined.by, at: declined.at };
}

/** Spec D2.3: status, outcome and scheduled time - nothing else of a tour. */
export function tourProjection(tour: TourItem): TourProjection {
  return {
    status: String(tour.status),
    outcome: typeof tour.outcome === 'string' ? tour.outcome : null,
    scheduledAt: typeof tour.scheduledAt === 'string' ? tour.scheduledAt : null,
  };
}

/** Whole days from `iso` to `now`, never negative; null when there is no instant. */
export function daysSince(iso: string | null, now: Date): number | null {
  const at = instantMs(iso);
  if (at === undefined) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
}

/** Spec D2.5: the pair's history from its seen-set entry; a pair never sent or toured has an empty one. */
export function pairHistoryOf(home: SeenHome | undefined, now: Date): PairHistory {
  if (home === undefined) return { sends: [], declined: null, tours: [], daysSinceLastSend: null };
  return {
    sends: home.sends.map((send) => ({ ...send })),
    declined: home.declined === null ? null : { ...home.declined },
    tours: home.tours.map((tour) => ({ ...tour })),
    daysSinceLastSend: daysSince(home.lastSendAt, now),
  };
}
