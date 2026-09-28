// share-sent-outcome T7: seed a COUNTED listing-send row the way the ledger
// stores one now that the blind upsert writer is retired. The seed goes
// THROUGH the ledger's own writer (applyShareLedgerEntry), so the row's
// counted / sentAt / broadcastId come from the service's own summary and a
// seeded row can never diverge from what the service writes (code review
// ADV-10): ONE counted entry keyed by the share (`individual` when there is
// none) whose attempt is the seeded key (`!legacy` / `!individual`, which
// sorts BEFORE every real attempt) and whose countedAt is `sentAt`. A second
// seed on the same pair under ANOTHER key merges into the row's memory (the
// latest counted entry names the pair's sentAt and broadcastId). A write the
// service refuses (a second seed under the SAME key - the order rule keeps
// the stored entry) or loses throws: a seed never fails silently.
import { createLogger } from '../../src/lib/logger.js';
import type { ListingSendsRepo, ShareLedgerEntry } from '../../src/repos/listingSendsRepo.js';
import { INDIVIDUAL_ATTEMPT_KEY, LEGACY_ATTEMPT_KEY } from '../../src/lib/shareAttemptOrder.js';
import { applyShareLedgerEntry } from '../../src/services/shareLedger.js';

/** The entry key of an individual send (the service's own key for a seeded row with no share id). */
const INDIVIDUAL_KEY = 'individual';
/** The service logs only a lost write, which this helper throws on anyway. */
const log = createLogger({ level: 'silent' });

export async function seedListingSend(
  repo: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>,
  args: { unitId: string; contactId: string; sentAt: string; broadcastId?: string },
): Promise<void> {
  const entry: ShareLedgerEntry = {
    attempt: args.broadcastId !== undefined ? LEGACY_ATTEMPT_KEY : INDIVIDUAL_ATTEMPT_KEY,
    state: 'counted',
    by: 'acceptance',
    countedAt: args.sentAt,
  };
  const result = await applyShareLedgerEntry(
    { listingSends: repo, log },
    { unitId: args.unitId, contactId: args.contactId, broadcastId: args.broadcastId ?? INDIVIDUAL_KEY, entry },
  );
  if (result !== 'written') {
    throw new Error(`seedListingSend: the seed write for ${args.unitId}|${args.contactId} was ${result}`);
  }
}
