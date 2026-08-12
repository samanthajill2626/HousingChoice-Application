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
import { summarizeError } from '../lib/errors.js';
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

/** Bounded retries for a TRANSIENT settings-table failure. See below. */
export const GROUP_FINGERPRINT_ATTEMPTS = 3;
/** First backoff step; doubled per attempt. */
export const GROUP_FINGERPRINT_BACKOFF_MS = 250;

/**
 * Compare (and on first boot, persist) the fingerprint. Returns what happened;
 * THROWS on a changed list so a deployed stack refuses to start.
 *
 * MISMATCH IS FATAL WITHOUT RETRY; "I COULD NOT READ IT" IS NOT THE SAME THING
 * (fix wave 5, adversarial 28). This runs before `app.listen` in the app AND
 * before the worker polls, so an unguarded throw takes the WHOLE product down -
 * 1:1 SMS, voice, email, relay, the dashboard API - none of which previously
 * had any DynamoDB dependency at boot. `claimGroupIdentityFingerprint` rethrows
 * anything that is not a ConditionalCheckFailedException, so an ECS task rolled
 * into a few seconds of settings-table throttling entered a restart loop. The
 * design intent ("a stack that would mint wrong ids must not serve") is about a
 * VERIFIED mismatch, which arrives as a returned outcome and is still fatal on
 * the first look. Only the transport gets retries, and exhausting them is fatal
 * too - with its own log line, so the two causes are never confused.
 */
export async function verifyGroupIdentityFingerprint(opts: {
  store: GroupFingerprintStore;
  excludedNumbers: readonly string[];
  /** True for deployed stacks only (NODE_ENV=production). */
  deployed: boolean;
  logger?: Logger;
  /** Test seam: total attempts against a THROWING store. */
  attempts?: number;
  /** Test seam: the backoff sleep. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<'skipped' | 'created' | 'matched'> {
  const log = opts.logger ?? defaultLogger;
  if (!opts.deployed) return 'skipped';

  const hash = groupIdentityFingerprint(opts.excludedNumbers);
  const attempts = Math.max(1, opts.attempts ?? GROUP_FINGERPRINT_ATTEMPTS);
  const sleep =
    opts.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

  let claim: GroupFingerprintClaim | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      claim = await opts.store.claimGroupIdentityFingerprint(hash);
      break;
    } catch (err) {
      lastError = err;
      if (attempt === attempts) break;
      log.warn(
        { attempt, attempts, err: summarizeError(err) },
        'group identity fingerprint read failed - retrying before refusing to boot',
      );
      await sleep(GROUP_FINGERPRINT_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }

  if (claim === undefined) {
    // FATAL, but a DIFFERENT fatality from a mismatch, and it says so: the list
    // is not known to have changed - we could not read the record at all.
    log.error(
      { attempts, err: summarizeError(lastError) },
      'group identity fingerprint could not be read after retries - refusing to boot',
    );
    throw new Error(
      'Could not read the GROUP_IDENTITY_EXCLUDED_NUMBERS fingerprint from the settings table ' +
        `after ${attempts} attempts. This is NOT a mismatch - the list is not known to have ` +
        'changed, and no migration is implied. It is a settings-table availability or ' +
        'permissions problem (throttling, a 5xx, a missing table, or an IAM policy that does not ' +
        'cover it). Refusing to start rather than serving with an unverified identity contract. ' +
        `Underlying error: ${summarizeError(lastError).message}`,
    );
  }

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
