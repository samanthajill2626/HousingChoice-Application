// clearRelayCloseNagOnReopen (tour auto-close spec 7.4 step 2, ruling F3): a
// tour reopen clears a pending close-nag on the tour's OWN open relay group,
// and never touches a group another owner holds. The owner is resolved the way
// every other reader resolves it - conversationsRepo's getOwner - so a legacy
// group carrying only the `placementId` back-reference (no `owner`) is
// placement-owned and keeps its nag. Best-effort: the helper never throws.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { ConversationItem, ConversationsRepo } from '../src/repos/conversationsRepo.js';
import { clearRelayCloseNagOnReopen } from '../src/services/relayCloseNag.js';
import { createLogCapture } from './helpers/logCapture.js';

const TOUR_ID = 'tour-1';
const GROUP_ID = 'conv-1';
const NAG_AT = '2026-10-29T12:00:00.000Z';
const INFO = 30;
const ERROR = 50;

/** An open relay group owned by TOUR_ID with a pending nag, unless overridden. */
function group(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    conversationId: GROUP_ID,
    status: 'open',
    last_activity_at: '2026-10-01T12:00:00.000Z',
    type: 'relay_group',
    ai_mode: 'manual',
    created_at: '2026-09-01T12:00:00.000Z',
    close_nag_next_at: NAG_AT,
    owner: { type: 'tour', id: TOUR_ID },
    ...overrides,
  };
}

/** The same group with `owner` REMOVED (an absent attribute, not undefined). */
function groupWithoutOwner(overrides: Partial<ConversationItem> = {}): ConversationItem {
  const { owner: _owner, ...rest } = group(overrides);
  return rest;
}

function harness(read: () => Promise<ConversationItem | undefined>) {
  const capture = createLogCapture();
  const getById = vi.fn<ConversationsRepo['getById']>(read);
  const setCloseNagNextAt = vi.fn<ConversationsRepo['setCloseNagNextAt']>(async () => {});
  const deps = {
    conversationsRepo: { getById, setCloseNagNextAt },
    logger: createLogger({ destination: capture.stream }),
  };
  return { deps, getById, setCloseNagNextAt, capture };
}

const serving = (conversation: ConversationItem | undefined) => async () => conversation;

describe('clearRelayCloseNagOnReopen', () => {
  it("clears the nag on the tour's own open relay group (one REMOVE write, info log)", async () => {
    const h = harness(serving(group()));
    await clearRelayCloseNagOnReopen(h.deps, GROUP_ID, TOUR_ID);
    expect(h.getById).toHaveBeenCalledWith(GROUP_ID);
    expect(h.setCloseNagNextAt).toHaveBeenCalledTimes(1);
    expect(h.setCloseNagNextAt).toHaveBeenCalledWith(GROUP_ID, null);
    const info = h.capture.atLevel(INFO).find((l) => l['msg'] === 'relay close-nag cleared on tour reopen');
    expect(info?.['conversationId']).toBe(GROUP_ID);
  });

  it('clears when the group has no owner attribute and no legacy back-reference', async () => {
    const h = harness(serving(groupWithoutOwner()));
    await clearRelayCloseNagOnReopen(h.deps, GROUP_ID, TOUR_ID);
    expect(h.setCloseNagNextAt).toHaveBeenCalledTimes(1);
    expect(h.setCloseNagNextAt).toHaveBeenCalledWith(GROUP_ID, null);
  });

  it('clears when the owner type is null (a standalone group)', async () => {
    const h = harness(serving(group({ owner: { type: null } })));
    await clearRelayCloseNagOnReopen(h.deps, GROUP_ID, TOUR_ID);
    expect(h.setCloseNagNextAt).toHaveBeenCalledTimes(1);
    expect(h.setCloseNagNextAt).toHaveBeenCalledWith(GROUP_ID, null);
  });

  it('leaves a placement-owned group alone', async () => {
    const h = harness(serving(group({ owner: { type: 'placement', id: 'p-1' } })));
    await clearRelayCloseNagOnReopen(h.deps, GROUP_ID, TOUR_ID);
    expect(h.setCloseNagNextAt).not.toHaveBeenCalled();
  });

  it("leaves another tour's group alone", async () => {
    const h = harness(serving(group({ owner: { type: 'tour', id: 'tour-2' } })));
    await clearRelayCloseNagOnReopen(h.deps, GROUP_ID, TOUR_ID);
    expect(h.setCloseNagNextAt).not.toHaveBeenCalled();
  });

  it('leaves a LEGACY placement group alone: placementId only, no owner (F3, getOwner)', async () => {
    const h = harness(serving(groupWithoutOwner({ placementId: 'p-legacy' })));
    await clearRelayCloseNagOnReopen(h.deps, GROUP_ID, TOUR_ID);
    expect(h.setCloseNagNextAt).not.toHaveBeenCalled();
  });

  it('leaves a closed group, a non-relay thread and a group with no nag alone', async () => {
    for (const conversation of [
      group({ status: 'closed' }),
      group({ type: 'tenant_1to1' }),
      group({ close_nag_next_at: undefined }),
    ]) {
      const h = harness(serving(conversation));
      await clearRelayCloseNagOnReopen(h.deps, GROUP_ID, TOUR_ID);
      expect(h.setCloseNagNextAt, JSON.stringify(conversation)).not.toHaveBeenCalled();
    }
  });

  it('does nothing when the conversation is missing', async () => {
    const h = harness(serving(undefined));
    await clearRelayCloseNagOnReopen(h.deps, GROUP_ID, TOUR_ID);
    expect(h.getById).toHaveBeenCalledTimes(1);
    expect(h.setCloseNagNextAt).not.toHaveBeenCalled();
  });

  it('does not even read when the tour has no group reference (missing or empty)', async () => {
    for (const ref of [undefined, '']) {
      const h = harness(serving(group()));
      await clearRelayCloseNagOnReopen(h.deps, ref, TOUR_ID);
      expect(h.getById, String(ref)).not.toHaveBeenCalled();
      expect(h.setCloseNagNextAt, String(ref)).not.toHaveBeenCalled();
    }
  });

  it('never throws when the read rejects - logs at error with the conversationId', async () => {
    const h = harness(async () => {
      throw new Error('dynamo unavailable');
    });
    await expect(clearRelayCloseNagOnReopen(h.deps, GROUP_ID, TOUR_ID)).resolves.toBeUndefined();
    expect(h.setCloseNagNextAt).not.toHaveBeenCalled();
    const err = h.capture.atLevel(ERROR).find((l) => l['msg'] === 'relay close-nag clear failed (best-effort)');
    expect(err?.['conversationId']).toBe(GROUP_ID);
  });

  it('never throws when the clear write rejects - logs at error', async () => {
    const h = harness(serving(group()));
    h.setCloseNagNextAt.mockRejectedValueOnce(new Error('conditional check failed'));
    await expect(clearRelayCloseNagOnReopen(h.deps, GROUP_ID, TOUR_ID)).resolves.toBeUndefined();
    expect(h.capture.atLevel(ERROR).map((l) => l['msg'])).toContain('relay close-nag clear failed (best-effort)');
  });
});
