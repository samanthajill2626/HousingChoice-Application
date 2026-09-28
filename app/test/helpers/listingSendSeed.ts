// share-sent-outcome T7: seed a COUNTED listing-send row the way the ledger
// stores one now that the blind upsert writer is retired - through putShareMemory, with ONE
// counted entry keyed by the share (`individual` when there is none) whose
// attempt is the seeded key (`!legacy` / `!individual`, which sorts BEFORE
// every real attempt) and whose countedAt is `sentAt`. A second seed on the
// same pair merges into the row's memory on its token (the pair's sentAt and
// broadcastId follow the latest counted entry, as the ledger's own summary
// does). A refused write throws: a seed never fails silently.
import type { ListingSendsRepo, ShareLedgerEntry } from '../../src/repos/listingSendsRepo.js';
import { INDIVIDUAL_ATTEMPT_KEY, LEGACY_ATTEMPT_KEY } from '../../src/lib/shareAttemptOrder.js';

const INDIVIDUAL_KEY = 'individual';

export async function seedListingSend(
  repo: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>,
  args: { unitId: string; contactId: string; sentAt: string; broadcastId?: string },
): Promise<void> {
  const key = args.broadcastId ?? INDIVIDUAL_KEY;
  const entry: ShareLedgerEntry = {
    attempt: args.broadcastId !== undefined ? LEGACY_ATTEMPT_KEY : INDIVIDUAL_ATTEMPT_KEY,
    state: 'counted',
    by: 'acceptance',
    countedAt: args.sentAt,
  };
  const row = await repo.getByKeyConsistent(args.unitId, args.contactId);
  const shares: Record<string, ShareLedgerEntry> = { ...(row?.shares ?? {}), [key]: entry };
  let latest: { key: string; at: string } | undefined;
  for (const [k, e] of Object.entries(shares)) {
    if (e.state !== 'counted' || e.countedAt === undefined) continue;
    if (latest === undefined || e.countedAt > latest.at) latest = { key: k, at: e.countedAt };
  }
  const ok = await repo.putShareMemory(
    args.unitId,
    args.contactId,
    {
      shares,
      counted: latest !== undefined,
      sentAt: latest?.at,
      broadcastId: latest === undefined || latest.key === INDIVIDUAL_KEY ? undefined : latest.key,
    },
    { token: row?.shares_op },
  );
  if (!ok) throw new Error(`seedListingSend: the seed write for ${args.unitId}|${args.contactId} lost its condition`);
}
