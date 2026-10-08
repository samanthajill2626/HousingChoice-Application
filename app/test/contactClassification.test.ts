// The contacts PATCH's classification side effects, moved to
// services/contactClassification.ts so the caseworker conversion (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D19 steps 2-3) calls the SAME code: the display-name denorm, the exact-identity
// delete + verdict stamp, and the revision-guarded type drain.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { AiRunsRepo } from '../src/repos/aiRunsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import {
  displayNameOf,
  drainTypeSuggestion,
  supersedePendingSuggestion,
} from '../src/services/contactClassification.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';

const ACTOR = 'usr_testva00000000000000000';
const AT = '2026-10-07T12:00:00.000Z';

function setup() {
  const world = createFakeWorld();
  const setVerdict = vi.fn<AiRunsRepo['setVerdict']>(async () => true);
  world.aiRuns.setVerdict = setVerdict;
  const capture = createLogCapture();
  const log = createLogger({ level: 'info', destination: capture.stream });
  return { world, setVerdict, capture, deps: { extraction: world.extractionRepo, aiRuns: world.aiRuns, log } };
}

describe('displayNameOf', () => {
  it('joins the trimmed parts, and answers null when no name is known', () => {
    expect(displayNameOf({ contactId: 'c', type: 'tenant', firstName: ' Ana ', lastName: 'Ruiz  ' })).toBe('Ana Ruiz');
    expect(displayNameOf({ contactId: 'c', type: 'tenant', firstName: 'Ana' })).toBe('Ana');
    expect(displayNameOf({ contactId: 'c', type: 'tenant', firstName: '  ', lastName: '' })).toBeNull();
  });
});

describe('supersedePendingSuggestion', () => {
  it('deletes the exact identity it was handed and stamps the verdict on its run', async () => {
    const { world, setVerdict, deps } = setup();
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    const deleted = await supersedePendingSuggestion(deps, {
      contactId: 'c1', target: 'pets', pending: item, verdict: 'superseded_by_human_edit', verdictAt: AT, actor: ACTOR,
    });
    expect(deleted).toBe(true);
    expect(await world.extractionRepo.getSuggestion('c1', 'pets')).toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith('run-1', 'pets', 'superseded_by_human_edit', {
      at: AT, expectedVerdict: 'pending', freshSuggestionCreatedAt: item.createdAt, by: ACTOR,
    });
  });

  it('leaves a replaced suggestion pending and unstamped', async () => {
    const { world, setVerdict, deps } = setup();
    const { item: old } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'two cats', conversationId: 'conv-1', runId: 'run-1',
    });
    await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'pets', suggestedValue: 'a dog', conversationId: 'conv-1', runId: 'run-2',
    });
    const deleted = await supersedePendingSuggestion(deps, {
      contactId: 'c1', target: 'pets', pending: old, verdict: 'superseded_by_human_edit', verdictAt: AT, actor: ACTOR,
    });
    expect(deleted).toBe(false);
    expect((await world.extractionRepo.getSuggestion('c1', 'pets'))?.runId).toBe('run-2');
    expect(setVerdict).not.toHaveBeenCalled();
  });

  it('deletes a suggestion on a non-decision target without stamping a verdict', async () => {
    const { world, setVerdict, deps } = setup();
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'lifEligible', suggestedValue: 'true', conversationId: 'conv-1', runId: 'run-1',
    });
    const deleted = await supersedePendingSuggestion(deps, {
      contactId: 'c1', target: 'lifEligible', pending: item, verdict: 'superseded_by_human_edit', verdictAt: AT,
    });
    expect(deleted).toBe(true);
    expect(setVerdict).not.toHaveBeenCalled();
  });
});

describe('drainTypeSuggestion', () => {
  function committedPartner(world: ReturnType<typeof createFakeWorld>, over: Partial<ContactItem> = {}): ContactItem {
    const c: ContactItem = { contactId: 'c1', type: 'partner', status: 'active', classification_revision: 1, ...over };
    world.contacts.push(c);
    return c;
  }

  it('records accepted when the pre-write identity equals the committed kind', async () => {
    const { world, setVerdict, deps } = setup();
    const committed = committedPartner(world);
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'type', suggestedValue: 'partner', conversationId: 'conv-1', runId: 'run-t',
      contactClassificationRevision: 0,
    });
    const changed = await drainTypeSuggestion(deps, {
      contactId: 'c1', committed, pendingTypeBefore: item, verdictAt: AT, actor: ACTOR,
    });
    expect(changed).toBe(true);
    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeUndefined();
    expect(setVerdict).toHaveBeenCalledWith('run-t', 'type', 'accepted', expect.objectContaining({ at: AT, by: ACTOR }));
  });

  it('records superseded_by_human_edit when the committed kind differs', async () => {
    const { world, setVerdict, deps } = setup();
    const committed = committedPartner(world, { type: 'landlord' });
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'type', suggestedValue: 'partner', conversationId: 'conv-1', runId: 'run-t',
      contactClassificationRevision: 0,
    });
    expect(await drainTypeSuggestion(deps, { contactId: 'c1', committed, pendingTypeBefore: item, verdictAt: AT })).toBe(true);
    expect(setVerdict).toHaveBeenCalledWith('run-t', 'type', 'superseded_by_human_edit', expect.anything());
  });

  it('leaves a suggestion written at or after the committed revision', async () => {
    const { world, setVerdict, deps } = setup();
    const committed = committedPartner(world);
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target: 'type', suggestedValue: 'tenant', conversationId: 'conv-1', runId: 'run-t',
      contactClassificationRevision: 1,
    });
    expect(await drainTypeSuggestion(deps, { contactId: 'c1', committed, pendingTypeBefore: item, verdictAt: AT })).toBe(false);
    expect(await world.extractionRepo.getSuggestion('c1', 'type')).toBeDefined();
    expect(setVerdict).not.toHaveBeenCalled();
  });
});

// C1: PATCH keeps warnings; conversion can report swallowed failures at error.
describe('optional failure reporting', () => {
  const failures = ['type-read', 'type-delete', 'other-delete', 'type-verdict', 'other-verdict', 'exhausted'] as const;
  it.each(failures)('reports %s through the supplied seam without throwing', async (failure) => {
    const { world, deps, capture } = setup();
    const committed: ContactItem = { contactId: 'c1', type: 'partner', classification_revision: 1 };
    world.contacts.push(committed);
    const target = failure.startsWith('other') ? 'pets' : 'type';
    const { item } = await world.extractionRepo.putSuggestion({
      ownerContactId: 'c1', target, suggestedValue: target === 'type' ? 'partner' : 'cat',
      conversationId: 'conv-1', runId: 'run-1', contactClassificationRevision: 0,
    });
    const error = new Error('injected follow-on failure');
    if (failure === 'type-read') vi.spyOn(world.extractionRepo, 'getSuggestion').mockRejectedValue(error);
    if (failure === 'type-delete') vi.spyOn(world.extractionRepo, 'deleteTypeSuggestionIfCurrentAtContactRevision').mockRejectedValue(error);
    if (failure === 'other-delete') vi.spyOn(world.extractionRepo, 'deleteSuggestionIfCurrent').mockRejectedValue(error);
    if (failure.endsWith('verdict')) vi.spyOn(world.aiRuns, 'setVerdict').mockRejectedValue(error);
    if (failure === 'exhausted') vi.spyOn(world.extractionRepo, 'deleteTypeSuggestionIfCurrentAtContactRevision').mockResolvedValue('suggestion_changed_or_absent');
    const reportFailure = vi.fn();
    const reportingDeps = { ...deps, reportFailure };
    if (target === 'pets') {
      await expect(supersedePendingSuggestion(reportingDeps, {
        contactId: 'c1', target, pending: item, verdict: 'superseded_by_human_edit', verdictAt: AT,
      })).resolves.toBe(failure === 'other-verdict');
    } else {
      await expect(drainTypeSuggestion(reportingDeps, {
        contactId: 'c1', committed, pendingTypeBefore: failure === 'type-read' ? undefined : item, verdictAt: AT,
      })).resolves.toBe(failure === 'type-verdict');
    }
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ contactId: 'c1', ...(failure !== 'exhausted' && { err: error }) }),
      expect.stringContaining(failure === 'exhausted' ? 'exhausted bounded retries' : 'failed (best-effort)'),
    );
    expect(capture.atLevel(40)).toEqual([]);
  });

  it('keeps the existing warning when no reporter is supplied', async () => {
    const { world, deps, capture } = setup();
    vi.spyOn(world.extractionRepo, 'getSuggestion').mockRejectedValue(new Error('read unavailable'));
    expect(await drainTypeSuggestion(deps, {
      contactId: 'c1', committed: { contactId: 'c1', type: 'partner', classification_revision: 1 },
      pendingTypeBefore: undefined, verdictAt: AT,
    })).toBe(false);
    expect(capture.atLevel(40)).toEqual([
      expect.objectContaining({ contactId: 'c1', msg: 'type suggestion drain read failed (best-effort)' }),
    ]);
    expect(capture.atLevel(50)).toEqual([]);
  });
});
