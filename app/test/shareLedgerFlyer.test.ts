// flyer-leads D7 / O1 (plan 2.2, AR2): applyFlyerShareEntry - a flyer
// sign-up's share entry through the ledger's own read-modify-write; the
// flyer-only CURRENT-decline refusal decided on each round's consistent read;
// the O1 race (a decline landing between the read and the write); the flyer's
// own lost-write line. The listing-sends fake used here is held to the real
// repo by twilioWebhookHarnessRepoAdditions.integration.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { effectiveDecline } from '../src/lib/listingSendOutcome.js';
import { FLYER_SHARE_KEY, flyerAttemptKey, latestCountedShareKey } from '../src/lib/shareLedgerKeys.js';
import type { ListingSendsRepo, ShareMemoryWrite } from '../src/repos/listingSendsRepo.js';
import { applyFlyerShareEntry, applyShareLedgerEntry, ledgerEntryFor } from '../src/services/shareLedger.js';
import { seedListingSend } from './helpers/listingSendSeed.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

type LedgerRepo = Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>;

const U = 'unit-1';
const C = 'c-1';
/** An earlier share of the pair (a broadcast). */
const SENT = '2026-10-01T12:00:00.000Z';
/** A staff Not interested after that share. */
const DECLINED = '2026-10-02T12:00:00.000Z';
/** Two flyer sign-ups, with milliseconds as `new Date().toISOString()` writes them. */
const SIGNED_1 = '2026-10-03T12:00:00.123Z';
const SIGNED_2 = '2026-10-04T08:30:00.456Z';
const FLYER_LOST_LINE =
  'share ledger: the flyer entry write lost its condition past the re-read bound - not repaired (the repair walks broadcast slots only)';
const FLYER_DECLINED_LINE = 'share ledger: flyer entry not written - the pair holds a current decline';
const SHARED_LOST_LINE = 'share ledger: the entry write lost its condition past the re-read bound - the repair heals it';

function setup() {
  const world = createFakeWorld();
  const capture = createLogCapture();
  const log = createLogger({ level: 'info', destination: capture.stream });
  const deps = (listingSends: LedgerRepo = world.listingSendsRepo) => ({ listingSends, log });
  const flyer = (signedUpAt: string, listingSends?: LedgerRepo) =>
    applyFlyerShareEntry(deps(listingSends), { unitId: U, contactId: C, signedUpAt });
  const row = () => world.listingSendsRepo.getByKeyConsistent(U, C);
  const sent = (sentAt = SENT, broadcastId = 'b-1') =>
    seedListingSend(world.listingSendsRepo, { unitId: U, contactId: C, sentAt, broadcastId });
  return { world, capture, deps, flyer, row, sent };
}

describe('applyFlyerShareEntry (flyer-leads D7)', () => {
  it('a NEW pair: one counted-by-acceptance flyer entry, sentAt = the sign-up instant, no broadcastId', async () => {
    const { flyer, row } = setup();
    expect(await flyer(SIGNED_1)).toBe('written');
    const r = await row();
    expect(r).toMatchObject({ counted: true, sentAt: SIGNED_1 });
    expect(r?.broadcastId).toBeUndefined();
    expect(r?.shares).toStrictEqual({
      [FLYER_SHARE_KEY]: { attempt: flyerAttemptKey(SIGNED_1), state: 'counted', by: 'acceptance', countedAt: SIGNED_1 },
    });
    expect(r?.shares?.['flyer']?.attempt).toBe('2026-10-03T12:00:00.123Z#flyer');
  });

  it('a pair already sent (whether or not the tenant replied - a contact fact, D8) gets the flyer entry as its LATEST counted entry; the sent share is kept; a legacy row keeps its seeded entry', async () => {
    const { world, deps, flyer, row, sent } = setup();
    await sent();
    expect(await flyer(SIGNED_1)).toBe('written');
    const r = await row();
    expect(latestCountedShareKey(r?.shares)).toBe(FLYER_SHARE_KEY);
    expect(r).toMatchObject({ counted: true, sentAt: SIGNED_1 });
    expect(r?.broadcastId).toBeUndefined();
    expect(r?.shares?.['b-1']).toMatchObject({ state: 'counted', countedAt: SENT });

    world.listingSends.push({ unitId: 'unit-legacy', contactId: C, sentAt: SENT, via: 'broadcast', broadcastId: 'b-old', created_at: SENT, updated_at: SENT });
    expect(await applyFlyerShareEntry(deps(), { unitId: 'unit-legacy', contactId: C, signedUpAt: SIGNED_1 })).toBe('written');
    const legacy = await world.listingSendsRepo.getByKeyConsistent('unit-legacy', C);
    expect(legacy?.shares?.['b-old']).toMatchObject({ attempt: '!legacy', state: 'counted', countedAt: SENT });
    expect(legacy).toMatchObject({ counted: true, sentAt: SIGNED_1 });
  });

  it('a CURRENT decline (at or after sentAt) answers declined: nothing written, ONE INFO line with ids only', async () => {
    const { world, capture, flyer, row, sent } = setup();
    await sent();
    expect(await world.listingSendsRepo.setDeclined(U, C, { at: DECLINED, by: 'staff', staffId: 'usr_x' })).toBe('ok');
    const before = await row();
    expect(effectiveDecline(before!, undefined)).toBe(true);
    expect(await flyer(SIGNED_1)).toBe('declined');
    expect(await row()).toStrictEqual(before);
    const info = capture.lines.filter((l) => l['msg'] === FLYER_DECLINED_LINE);
    expect(info).toHaveLength(1);
    expect(info[0]).toMatchObject({ level: 30, unitId: U, contactId: C });
    expect(info[0]).not.toHaveProperty('staffId');
  });

  it('an UNCOUNTED row that still holds a decline refuses too (no sentAt: any decline is current)', async () => {
    const { world, deps, flyer, row, sent } = setup();
    await sent();
    await world.listingSendsRepo.setDeclined(U, C, { at: DECLINED, by: 'staff' });
    // The pair's one share later failed: the row stops counting (sentAt REMOVED); the decline stays.
    const failed = ledgerEntryFor('2026-10-02T13:00:00.000Z#SM2', 'conv-1', { kind: 'failed' });
    expect(await applyShareLedgerEntry(deps(), { unitId: U, contactId: C, broadcastId: 'b-1', entry: failed })).toBe('written');
    expect(await row()).toMatchObject({ counted: false, declined: { at: DECLINED } });
    expect((await row())?.sentAt).toBeUndefined();
    expect(await flyer(SIGNED_1)).toBe('declined');
    expect((await row())?.shares?.[FLYER_SHARE_KEY]).toBeUndefined();
  });

  it('a decline OLDER than sentAt (superseded by a later share) does not refuse: the flyer entry is written and the decline record is left as it was', async () => {
    const { world, flyer, row, sent } = setup();
    await sent();
    await world.listingSendsRepo.setDeclined(U, C, { at: DECLINED, by: 'staff' });
    await sent('2026-10-02T18:00:00.000Z', 'b-2');
    expect(effectiveDecline((await row())!, undefined)).toBe(false);
    expect(await flyer(SIGNED_1)).toBe('written');
    expect(await row()).toMatchObject({ sentAt: SIGNED_1, declined: { at: DECLINED, by: 'staff' } });
  });

  it('(PIN) the refusal is flyer-only: a broadcast entry to a pair with a CURRENT decline still writes and supersedes it', async () => {
    const { world, deps, row, sent } = setup();
    await sent();
    await world.listingSendsRepo.setDeclined(U, C, { at: DECLINED, by: 'staff' });
    const entry = ledgerEntryFor('2026-10-03T09:00:00.000Z#SMb2', 'conv-1', { kind: 'accepted' });
    expect(await applyShareLedgerEntry(deps(), { unitId: U, contactId: C, broadcastId: 'b-2', entry })).toBe('written');
    const r = await row();
    expect(r).toMatchObject({ sentAt: '2026-10-03T09:00:00.000Z', broadcastId: 'b-2' });
    expect(effectiveDecline(r!, undefined)).toBe(false);
  });

  it('repeat sign-ups move sentAt forward; an equal or older sign-up instant is refused by the order rule (AR2)', async () => {
    const { flyer, row } = setup();
    expect(await flyer(SIGNED_1)).toBe('written');
    expect(await flyer(SIGNED_2)).toBe('written');
    expect(await row()).toMatchObject({ sentAt: SIGNED_2 });
    expect((await row())?.shares?.[FLYER_SHARE_KEY]?.attempt).toBe(flyerAttemptKey(SIGNED_2));
    expect(await flyer(SIGNED_2)).toBe('refused');
    expect(await flyer(SIGNED_1)).toBe('refused');
    expect(await row()).toMatchObject({ sentAt: SIGNED_2 });
  });

  it('a decline recorded AFTER a sign-up holds against the next sign-up (it is at or after the sentAt that sign-up moved)', async () => {
    const { world, flyer, row, sent } = setup();
    await sent();
    expect(await flyer(SIGNED_1)).toBe('written');
    expect(await world.listingSendsRepo.setDeclined(U, C, { at: '2026-10-03T15:00:00.000Z', by: 'staff' })).toBe('ok');
    expect(await flyer(SIGNED_2)).toBe('declined');
    expect(await row()).toMatchObject({ sentAt: SIGNED_1 });
    expect((await row())?.shares?.[FLYER_SHARE_KEY]?.attempt).toBe(flyerAttemptKey(SIGNED_1));
  });

  it('O1: a decline landing between the ledger read and its write makes the flyer write lose its token, re-read and answer declined - nothing written; a broadcast write in the same race re-reads and still writes', async () => {
    for (const writer of ['flyer', 'broadcast'] as const) {
      const { world, deps, row, sent } = setup();
      await sent();
      let reads = 0;
      let raced = false;
      const racing: LedgerRepo = {
        async getByKeyConsistent(u, c) {
          reads += 1;
          return world.listingSendsRepo.getByKeyConsistent(u, c);
        },
        async putShareMemory(u, c, next, expected) {
          if (!raced) {
            raced = true;
            // A staff Not interested lands after the ledger's consistent read.
            expect(await world.listingSendsRepo.setDeclined(u, c, { at: DECLINED, by: 'staff', staffId: 'usr_x' })).toBe('ok');
          }
          return world.listingSendsRepo.putShareMemory(u, c, next, expected);
        },
      };
      if (writer === 'flyer') {
        expect(await applyFlyerShareEntry(deps(racing), { unitId: U, contactId: C, signedUpAt: SIGNED_1 })).toBe('declined');
        const r = await row();
        expect(r?.shares?.[FLYER_SHARE_KEY]).toBeUndefined();
        expect(r).toMatchObject({ sentAt: SENT, broadcastId: 'b-1', declined: { at: DECLINED, by: 'staff' } });
      } else {
        const entry = ledgerEntryFor('2026-10-03T09:00:00.000Z#SMb2', 'conv-1', { kind: 'accepted' });
        expect(await applyShareLedgerEntry(deps(racing), { unitId: U, contactId: C, broadcastId: 'b-2', entry })).toBe('written');
        expect(await row()).toMatchObject({ sentAt: '2026-10-03T09:00:00.000Z', broadcastId: 'b-2' });
      }
      expect(reads).toBe(2); // the lost condition forced exactly ONE re-read
    }
  });

  it('lost: past the re-read bound the flyer write answers lost with ONE ERROR - its own line, never the shared "the repair heals it" wording; applyShareLedgerEntry keeps the shared line', async () => {
    const { world, capture, deps, flyer } = setup();
    const puts = vi.fn(async (_u: string, _c: string, _n: ShareMemoryWrite, _e: { token: string | undefined }) => false);
    const losing: LedgerRepo = { getByKeyConsistent: (u, c) => world.listingSendsRepo.getByKeyConsistent(u, c), putShareMemory: puts };
    expect(await flyer(SIGNED_1, losing)).toBe('lost');
    expect(puts).toHaveBeenCalledTimes(4); // 1 + MAX_REAPPLY (3) writes
    const errors = capture.atLevel(50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ msg: FLYER_LOST_LINE, unitId: U, contactId: C, shareKey: FLYER_SHARE_KEY, attempt: flyerAttemptKey(SIGNED_1), state: 'counted' });
    expect(errors[0]).not.toHaveProperty('broadcastId');
    expect(capture.lines.some((l) => l['msg'] === SHARED_LOST_LINE)).toBe(false);

    const entry = ledgerEntryFor('2026-10-03T09:00:00.000Z#SM1', 'conv-1', { kind: 'accepted' });
    expect(await applyShareLedgerEntry(deps(losing), { unitId: U, contactId: C, broadcastId: 'b-1', entry })).toBe('lost');
    expect(capture.atLevel(50)[1]).toMatchObject({ msg: SHARED_LOST_LINE, broadcastId: 'b-1' });
  });
});
