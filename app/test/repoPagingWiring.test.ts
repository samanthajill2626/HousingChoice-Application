// Repo -> queryAll WIRING.
//
// `queryAll` is well covered on its own (test/dynamoPaging.test.ts). This file
// covers the half that was missing: that the repos actually USE it. An
// adversarial review found the gap by the only test that matters - reverting a
// repo to its old single-`QueryCommand` body left the whole suite green, which
// is precisely the silent-truncation defect this branch exists to remove,
// sitting unguarded inside the branch that removes it.
//
// Each case serves TWO pages from a fake doc client and asserts the repo
// returned BOTH. A repo that stopped following `LastEvaluatedKey` returns only
// the first page and fails here.
import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createListingSendsRepo } from '../src/repos/listingSendsRepo.js';
import { createToursRepo } from '../src/repos/toursRepo.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const logger = createLogger({ destination: createLogCapture().stream });

/** A doc client that serves `pages` in order, recording each ExclusiveStartKey. */
function twoPages(first: Record<string, unknown>[], second: Record<string, unknown>[]) {
  const starts: (Record<string, unknown> | undefined)[] = [];
  let call = 0;
  const doc = {
    send: async (cmd: { input?: { ExclusiveStartKey?: Record<string, unknown> } }) => {
      starts.push(cmd.input?.ExclusiveStartKey);
      const page =
        call === 0 ? { Items: first, LastEvaluatedKey: { k: 1 } } : { Items: second };
      call += 1;
      return page;
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, starts };
}

describe('repos follow LastEvaluatedKey (queryAll wiring)', () => {
  it('conversationsRepo.findByParticipantPhone returns BOTH pages', async () => {
    // Backs conversationsForContact, which the unread-counts route and the
    // contact file both depend on - a dropped key silently loses a person's
    // older threads.
    const { doc, starts } = twoPages([{ conversationId: 'c1' }], [{ conversationId: 'c2' }]);
    const repo = createConversationsRepo({ doc, logger });
    const rows = await repo.findByParticipantPhone('+14045550111');
    expect(rows.map((r) => r.conversationId)).toEqual(['c1', 'c2']);
    expect(starts).toEqual([undefined, { k: 1 }]);
  });

  it('conversationsRepo.findByParticipantEmail returns BOTH pages', async () => {
    const { doc } = twoPages([{ conversationId: 'c1' }], [{ conversationId: 'c2' }]);
    const repo = createConversationsRepo({ doc, logger });
    const rows = await repo.findByParticipantEmail('k@example.com');
    expect(rows.map((r) => r.conversationId)).toEqual(['c1', 'c2']);
  });

  it('listingSendsRepo.listByContact returns BOTH pages', async () => {
    const { doc } = twoPages([{ unitId: 'u1' }], [{ unitId: 'u2' }]);
    const repo = createListingSendsRepo({ doc, logger });
    const rows = await repo.listByContact('contact-1');
    expect(rows.map((r) => r.unitId)).toEqual(['u1', 'u2']);
  });

  it('listingSendsRepo.listByUnit returns BOTH pages', async () => {
    const { doc } = twoPages([{ contactId: 'k1' }], [{ contactId: 'k2' }]);
    const repo = createListingSendsRepo({ doc, logger });
    const rows = await repo.listByUnit('unit-1');
    expect(rows.map((r) => r.contactId)).toEqual(['k1', 'k2']);
  });

  it('toursRepo.listByTenant returns BOTH pages (the shared GSI helper)', async () => {
    // listByStatus was fixed to walk long ago; the helper behind
    // listByTenant/listByUnit was missed in that pass.
    const { doc } = twoPages([{ tourId: 't1' }], [{ tourId: 't2' }]);
    const repo = createToursRepo({ doc, logger });
    const rows = await repo.listByTenant('contact-1');
    expect(rows.map((r) => r.tourId)).toEqual(['t1', 't2']);
  });

  it('toursRepo.listByUnit returns BOTH pages', async () => {
    const { doc } = twoPages([{ tourId: 't1' }], [{ tourId: 't2' }]);
    const repo = createToursRepo({ doc, logger });
    const rows = await repo.listByUnit('unit-1');
    expect(rows.map((r) => r.tourId)).toEqual(['t1', 't2']);
  });
});
