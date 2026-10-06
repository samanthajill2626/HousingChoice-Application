// The ONE in-memory model of an All-tab phase read (toursRepo.queryListPhase,
// spec docs/superpowers/specs/2026-10-06-tour-list-design.md 5.3-5.4), shared
// by the harness fake and the paging engine's tests, and pinned to the real
// repo by tourListIndexFakeMirror.integration.test.ts. It mirrors the REAL
// Query semantics, not a convenient approximation (the house rules of
// unreadIndexFake.ts / contactsPartitionFake.ts):
//   - membership: D = rows WITH scheduledAt (and _schedPartition 'tours'),
//     inside the range; U = rows of the phase's status;
//   - order: by the index range key (scheduledAt / createdAt), ascending when
//     `forward`, else descending;
//   - Limit counts EVALUATED rows, BEFORE the FilterExpression - a filtered-out
//     row still spends its slot;
//   - a lastEvaluatedKey (the FULL key: tourId + the index keys) comes back
//     whenever the page evaluated exactly `limit` rows, even when nothing
//     follows - never when the range ran out first;
//   - scannedCount = the rows evaluated;
//   - resume is by KEY POSITION: the first row strictly after the start key's
//     (range key, tourId) in the read's order - whether or not that key's row
//     still exists or still sits there (a deleted or rescheduled tour);
//   - a start key OUTSIDE the key condition (another partition, or a range
//     key outside the phase's range) is REJECTED with a ValidationException-
//     named error, as DynamoDB rejects it. The message is DynamoDB Local's,
//     measured 2026-10-06 for every range op, both directions, the exclusive
//     `lt` bound itself, a wrong partition and a wrong status: "The provided
//     starting key does not match the range key predicate". (The plan quoted
//     AWS's wording as "...is outside query boundaries based on provided
//     conditions".) The text is not a contract - match on the NAME, as the
//     route's cursor-400 mapping does. Route test 3 and that mapping depend
//     on the rejection.
// WHERE IT KNOWINGLY DIFFERS - TIES: rows sharing a range-key value come back
// here by tourId (ascending forward); DynamoDB orders them opaquely. So a start
// key whose range-key value another row of the phase also holds THROWS a PLAIN
// Error (never a ValidationException-named one: a route test must see a 500,
// not a misleading 400 'invalid cursor') unless the caller opts in with
// `allowTieResume` - the house guard of unreadIndexFake.ts. Keep tied
// timestamps out of paging fixtures unless the tie IS the subject.
import { tourListKeyOf, type TourListPhase } from '../../src/lib/tourListQuery.js';
import type { TourItem } from '../../src/repos/toursRepo.js';

/** Ascending (range key, tourId) order - the fake's whole notion of position. */
function compareKeys(rangeA: string, idA: string, rangeB: string, idB: string): number {
  if (rangeA !== rangeB) return rangeA < rangeB ? -1 : 1;
  if (idA !== idB) return idA < idB ? -1 : 1;
  return 0;
}

/** DynamoDB refuses a start key that its Query's key condition excludes. */
function outsideKeyCondition(phase: TourListPhase, k: Record<string, string>): boolean {
  if (phase.kind === 'u') return k['status'] !== phase.status;
  if (k['_schedPartition'] !== 'tours') return true;
  const at = k['scheduledAt'];
  return at === undefined || !inRange(phase, at);
}

function inRange(phase: Extract<TourListPhase, { kind: 'd' }>, at: string): boolean {
  const r = phase.range;
  switch (r.op) {
    case 'all':
      return true;
    case 'gte':
      return at >= r.value;
    case 'lt':
      return at < r.value;
    case 'lte':
      return at <= r.value;
    case 'between':
      return at >= r.from && at <= r.to;
  }
}

export function queryListPhaseFromItems(
  rows: readonly TourItem[],
  phase: TourListPhase,
  opts: {
    limit: number;
    startKey?: Record<string, string>;
    forward: boolean;
    /**
     * Permit a start key whose range-key value is TIED with another row of the
     * phase. By default that throws (see the header): it is the one input where
     * this fake and DynamoDB can resume into DIFFERENT row sets. Pass true ONLY
     * for a test of the cursor MECHANISM that does not read its row sets as
     * service behaviour, and say so in a comment at the call site.
     */
    allowTieResume?: boolean;
  },
): { items: TourItem[]; lastEvaluatedKey?: Record<string, string>; scannedCount: number } {
  const rangeOf = (t: TourItem): string => String(phase.kind === 'd' ? t.scheduledAt : t.createdAt);
  const members = rows.filter((t) =>
    phase.kind === 'd'
      ? typeof t.scheduledAt === 'string' && t._schedPartition === 'tours' && inRange(phase, t.scheduledAt)
      : t.status === phase.status,
  );
  const ordered = [...members].sort((a, b) => {
    const cmp = compareKeys(rangeOf(a), a.tourId, rangeOf(b), b.tourId);
    return opts.forward ? cmp : -cmp;
  });
  let start = 0;
  if (opts.startKey !== undefined) {
    const k = opts.startKey;
    if (outsideKeyCondition(phase, k)) {
      throw Object.assign(new Error('The provided starting key does not match the range key predicate'), {
        name: 'ValidationException',
      });
    }
    const kRange = (phase.kind === 'd' ? k['scheduledAt'] : k['createdAt']) ?? '';
    const kId = k['tourId'] ?? '';
    if (opts.allowTieResume !== true && ordered.some((t) => rangeOf(t) === kRange && t.tourId !== kId)) {
      throw new Error(
        `tourListIndexFake: the start key (${phase.kind === 'd' ? 'scheduledAt' : 'createdAt'}=${kRange}, ` +
          `tourId=${kId}) lands inside a range-key TIE, where this fake's row order (by tourId) diverges ` +
          `from DynamoDB's opaque one and the resumed row SET could differ. Give the fixture distinct ` +
          `timestamps, or - if the test exercises the cursor mechanism rather than service behaviour - ` +
          `pass allowTieResume: true with a comment.`,
      );
    }
    start = ordered.findIndex((t) => {
      const cmp = compareKeys(rangeOf(t), t.tourId, kRange, kId);
      return opts.forward ? cmp > 0 : cmp < 0;
    });
    if (start < 0) start = ordered.length;
  }
  const evaluated = ordered.slice(start, start + opts.limit);
  const items = evaluated.filter((t) => {
    if (
      phase.kind === 'd' &&
      phase.statusFilter !== undefined &&
      !(phase.statusFilter as readonly string[]).includes(t.status)
    ) {
      return false;
    }
    if (phase.kind === 'u' && phase.notExists && typeof t.scheduledAt === 'string') return false;
    if (phase.type !== undefined && t.tourType !== phase.type) return false;
    return true;
  });
  const last = evaluated[evaluated.length - 1];
  return {
    items: items.map((t) => ({ ...t })),
    scannedCount: evaluated.length,
    ...(evaluated.length === opts.limit && last !== undefined && { lastEvaluatedKey: tourListKeyOf(last, phase) }),
  };
}
