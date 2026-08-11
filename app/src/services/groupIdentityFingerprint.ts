// Group identity fingerprint (spec 4.1) - the deploy-time immutability guard on
// GROUP_IDENTITY_EXCLUDED_NUMBERS.
//
// The exclusion list is part of the group thread ID: ids are derived from the
// roster left AFTER the list is subtracted. Changing it re-mints the id of every
// group containing a changed number - the old threads are orphaned and the next
// inbound starts a SECOND thread for the same people, with no back-pointer
// between them. That is a migration, not a config edit, so a deployed stack
// pins a fingerprint of the sorted list on first boot and refuses to start when
// the configured list stops matching.
//
// DEPLOYED ENVIRONMENTS ONLY. Local and hermetic stacks reseed (which wipes the
// settings table), so a fingerprint there protects nothing and would fail every
// lane after the first reseed.
import { createHash } from 'node:crypto';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

/** Outcome of the conditional claim (the settings repo implements this). */
export interface GroupFingerprintClaim {
  /** `created` = this boot wrote it; `matched` = unchanged; `mismatch` = changed. */
  outcome: 'created' | 'matched' | 'mismatch';
  /** The persisted hash, present on `mismatch` (for the operator message). */
  storedHash?: string;
}

/** The narrow settings seam this service needs (settingsRepo satisfies it). */
export interface GroupFingerprintStore {
  claimGroupIdentityFingerprint(hash: string): Promise<GroupFingerprintClaim>;
}

/**
 * The fingerprint: sha256 over the SORTED, deduped list. Order and duplicates in
 * the env value are not semantic, so they must not move the hash - only the SET
 * of numbers may.
 */
export function groupIdentityFingerprint(excludedNumbers: readonly string[]): string {
  const canonical = [...new Set(excludedNumbers)].sort().join(',');
  return createHash('sha256').update(`groupExclusion:${canonical}`, 'utf8').digest('hex');
}

/**
 * Compare (and on first boot, persist) the fingerprint. Returns what happened;
 * THROWS on a changed list so a deployed stack refuses to start.
 */
export async function verifyGroupIdentityFingerprint(opts: {
  store: GroupFingerprintStore;
  excludedNumbers: readonly string[];
  /** True for deployed stacks only (NODE_ENV=production). */
  deployed: boolean;
  logger?: Logger;
}): Promise<'skipped' | 'created' | 'matched'> {
  const log = opts.logger ?? defaultLogger;
  if (!opts.deployed) return 'skipped';

  const hash = groupIdentityFingerprint(opts.excludedNumbers);
  const claim = await opts.store.claimGroupIdentityFingerprint(hash);

  if (claim.outcome === 'mismatch') {
    // Un-misconfigurable, same tier as the unset case. The message names the
    // whole procedure on purpose: the tempting "fix" - delete the settings
    // record and reboot - silently forks every group thread in the database.
    throw new Error(
      'GROUP_IDENTITY_EXCLUDED_NUMBERS no longer matches the fingerprint this environment ' +
        'was started with. That list is part of the group-thread identity contract: changing it ' +
        're-mints the conversationId of every carrier group containing a changed number, so ' +
        'existing threads are orphaned and the next inbound opens a SECOND thread for the same ' +
        'people. Refusing to start. If the change is DELIBERATE it is a migration-grade decision ' +
        'and needs, in order: the decision recorded, a thread-merge plan for the affected groups, ' +
        'then the fingerprint reset step - see RUNBOOK.md ("group identity exclusion list"). If it ' +
        'is NOT deliberate, restore the previous value and restart.',
    );
  }

  // Counts + outcome only - the numbers themselves are PII (doc 9).
  log.info(
    { outcome: claim.outcome, excludedCount: opts.excludedNumbers.length },
    'group identity exclusion fingerprint verified',
  );
  return claim.outcome;
}
