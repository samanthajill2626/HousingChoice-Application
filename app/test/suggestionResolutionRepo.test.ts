import { describe, expect, it } from 'vitest';
import type { SuggestionItem } from '../src/repos/extractionRepo.js';
import {
  makeCompletedResolution,
  resolutionItemId,
  suggestionIdentityKey,
  type ActiveSuggestionResolution,
} from '../src/repos/suggestionResolutionRepo.js';

function suggestion(over: Partial<SuggestionItem> = {}): SuggestionItem {
  return {
    itemId: 'sugg#contact-1#pets',
    ownerContactId: 'contact-1',
    target: 'pets',
    suggestedValue: 'two cats',
    conversationId: 'conversation-1',
    createdAt: '2026-08-08T12:00:00.000Z',
    _pendingPartition: 'pending',
    ...over,
  };
}

describe('suggestion resolution identity', () => {
  it('uses the exact immutable revision for a modern suggestion', () => {
    expect(suggestionIdentityKey(suggestion({ revision: 'revision-7' }))).toBe(
      'revision#revision-7',
    );
  });

  it('hashes exact createdAt/runId identity for a legacy suggestion', () => {
    const withRun = suggestionIdentityKey(suggestion({ runId: 'run-4' }));
    const withoutRun = suggestionIdentityKey(suggestion());
    expect(withRun).toMatch(/^legacy#[0-9a-f]{32}$/);
    expect(withoutRun).toMatch(/^legacy#[0-9a-f]{32}$/);
    expect(withRun).not.toBe(withoutRun);
    expect(
      suggestionIdentityKey(suggestion({ createdAt: '2026-08-08T12:00:01.000Z' })),
    ).not.toBe(withoutRun);
  });

  it('uses one bounded row per contact and target', () => {
    expect(resolutionItemId('contact-1', 'pets')).toBe('resolve#contact-1#pets');
  });
});

function active(): ActiveSuggestionResolution {
  return {
    itemId: resolutionItemId('contact-1', 'pets'),
    state: 'active',
    contactId: 'contact-1',
    target: 'pets',
    identityKey: 'revision#revision-7',
    action: 'accept',
    actorId: 'user-1',
    snapshot: suggestion({ revision: 'revision-7' }),
    plan: {
      kind: 'contact',
      patch: { pets: 'two cats' },
      guard: { pets: { exists: false } },
      audit: { eventType: 'suggestion_accepted', payload: { value: 'two cats' } },
    },
    phase: 'claimed',
    leaseId: 'lease-1',
    leaseExpiresAt: '2026-08-08T12:01:00.000Z',
    fence: 1,
    claimedAt: '2026-08-08T12:00:00.000Z',
  };
}

describe('completed suggestion resolution rows', () => {
  it('scrubs the snapshot, replay plan, actor, lease, and phase', () => {
    const completed = makeCompletedResolution(active(), '2026-08-08T12:02:00.000Z');

    expect(completed).toEqual({
      itemId: 'resolve#contact-1#pets',
      state: 'completed',
      contactId: 'contact-1',
      target: 'pets',
      identityKey: 'revision#revision-7',
      action: 'accept',
      completedAt: '2026-08-08T12:02:00.000Z',
    });
    expect(JSON.stringify(completed)).not.toContain('two cats');
    expect(JSON.stringify(completed)).not.toContain('user-1');
  });

  // F8: a journal finalized because restoring its suggestion was unsafe records
  // WHY it ended, and nothing else - the row stays as PII-free as an ordinary one.
  it('records a released-unsafe disposition without carrying any suggestion detail', () => {
    const completed = makeCompletedResolution(active(), '2026-08-08T12:02:00.000Z', 'released_unsafe');

    expect(completed).toEqual({
      itemId: 'resolve#contact-1#pets',
      state: 'completed',
      contactId: 'contact-1',
      target: 'pets',
      identityKey: 'revision#revision-7',
      action: 'accept',
      completedAt: '2026-08-08T12:02:00.000Z',
      disposition: 'released_unsafe',
    });
    expect(JSON.stringify(completed)).not.toContain('two cats');
    expect(JSON.stringify(completed)).not.toContain('user-1');
  });
});
