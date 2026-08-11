// Group identity fingerprint (spec 4.1) - the deploy-time immutability guard.
//
// The exclusion list is part of the group thread ID. Changing it re-mints the id
// of every group containing a changed number, orphaning those threads and
// starting second threads for the same people. So a DEPLOYED stack persists a
// fingerprint of the sorted list on first boot and REFUSES to start when the
// configured list no longer matches - the same "un-misconfigurable" tier as the
// unset case. Local/hermetic stacks skip it entirely (reseeds wipe the settings
// table, where a fingerprint would protect nothing and break every reseed).
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import {
  groupIdentityFingerprint,
  verifyGroupIdentityFingerprint,
  type GroupFingerprintClaim,
  type GroupFingerprintStore,
} from '../src/services/groupIdentityFingerprint.js';
import { createLogCapture } from './helpers/logCapture.js';

/** An in-memory stand-in for the settings record (the repo's conditional create). */
function fakeStore(initial?: string): GroupFingerprintStore & { stored?: string; calls: number } {
  const state = {
    stored: initial,
    calls: 0,
    async claimGroupIdentityFingerprint(hash: string): Promise<GroupFingerprintClaim> {
      state.calls += 1;
      if (state.stored === undefined) {
        state.stored = hash;
        return { outcome: 'created' };
      }
      return state.stored === hash
        ? { outcome: 'matched' }
        : { outcome: 'mismatch', storedHash: state.stored };
    },
  };
  return state;
}

const logger = createLogger({ destination: createLogCapture().stream });

describe('groupIdentityFingerprint (the hash itself)', () => {
  it('is stable and independent of order and duplicates', () => {
    const a = groupIdentityFingerprint(['+15550001111', '+15550002222']);
    expect(groupIdentityFingerprint(['+15550002222', '+15550001111'])).toBe(a);
    expect(groupIdentityFingerprint(['+15550001111', '+15550002222', '+15550001111'])).toBe(a);
  });

  it('changes when a number is added or removed', () => {
    const a = groupIdentityFingerprint(['+15550001111', '+15550002222']);
    expect(groupIdentityFingerprint(['+15550001111'])).not.toBe(a);
    expect(groupIdentityFingerprint(['+15550001111', '+15550002222', '+15550003333'])).not.toBe(a);
  });

  it('distinguishes the deliberate empty list from any populated one', () => {
    expect(groupIdentityFingerprint([])).not.toBe(groupIdentityFingerprint(['+15550001111']));
    expect(groupIdentityFingerprint([])).toBe(groupIdentityFingerprint([]));
  });
});

describe('verifyGroupIdentityFingerprint', () => {
  it('writes the fingerprint on a deployed first boot', async () => {
    const store = fakeStore();
    const outcome = await verifyGroupIdentityFingerprint({
      store,
      excludedNumbers: ['+15550001111'],
      deployed: true,
      logger,
    });
    expect(outcome).toBe('created');
    expect(store.stored).toBe(groupIdentityFingerprint(['+15550001111']));
  });

  it('accepts an unchanged list on a later boot', async () => {
    const store = fakeStore(groupIdentityFingerprint(['+15550001111']));
    await expect(
      verifyGroupIdentityFingerprint({
        store,
        excludedNumbers: ['+15550001111'],
        deployed: true,
        logger,
      }),
    ).resolves.toBe('matched');
  });

  it('THROWS on a changed list, naming the deliberate-change procedure', async () => {
    const store = fakeStore(groupIdentityFingerprint(['+15550001111']));
    await expect(
      verifyGroupIdentityFingerprint({
        store,
        excludedNumbers: ['+15550001111', '+15550002222'],
        deployed: true,
        logger,
      }),
    ).rejects.toThrow(/GROUP_IDENTITY_EXCLUDED_NUMBERS/);

    const err = await verifyGroupIdentityFingerprint({
      store,
      excludedNumbers: ['+15550002222'],
      deployed: true,
      logger,
    }).then(
      () => new Error('expected a throw'),
      (e: unknown) => e as Error,
    );
    // The operator message must name all three steps, or the person reading it
    // at 2am will "fix" it by deleting the record and silently fork the data.
    expect(err.message).toMatch(/migration/i);
    expect(err.message).toMatch(/merge/i);
    expect(err.message).toMatch(/RUNBOOK/);
  });

  it('SKIPS entirely on a local/hermetic stack (never touches the store)', async () => {
    const store = fakeStore(groupIdentityFingerprint(['+15550009999']));
    await expect(
      verifyGroupIdentityFingerprint({
        store,
        excludedNumbers: ['+15550001111'],
        deployed: false,
        logger,
      }),
    ).resolves.toBe('skipped');
    expect(store.calls).toBe(0);
  });
});
