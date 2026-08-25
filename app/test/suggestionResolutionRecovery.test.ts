// recoverAbandoned's per-call ATTEMPT budget, driven directly against the
// service (log-hygiene Task 12 / spec 9.3).
//
// WHY A NEW HARNESS (worklist ADJ-D2): every existing exercise of
// recoverAbandoned is HTTP-driven through the suggestions read path
// (aiRunVerdicts.test.ts), which has no way to pass an options bag - so the
// budget widening the daily sweep depends on is unreachable from there. No app
// test constructed createSuggestionResolutionService directly before this file.
//
// The deps interface is not exported, so the service is built from a plain
// object literal. Only the three seams this budget touches are real:
// listJournals (what recovery enumerates), takeover (the first round trip a
// budgeted attempt spends), and the logger. The remaining repos are never
// reached, because every takeover here is REFUSED on purpose: a refused
// takeover still consumes its attempt, which is exactly the property the cap
// exists to bound - a contact whose journals keep failing must not walk all
// twelve keys on an ordinary page read.
import { describe, expect, it, vi } from 'vitest';
import type { AiRunsRepo } from '../src/repos/aiRunsRepo.js';
import type { ContactsRepo } from '../src/repos/contactsRepo.js';
import type { ExtractionRepo } from '../src/repos/extractionRepo.js';
import type {
  ActiveSuggestionResolution,
  SuggestionResolutionRepo,
} from '../src/repos/suggestionResolutionRepo.js';
import { createSuggestionResolutionService } from '../src/services/suggestionResolution.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const NOW = '2026-08-25T12:00:00.000Z';
const CONTACT = 'contact-recovery';

/** A lease-expired active journal - the shape recovery filters on. */
function expiredJournal(target: string): ActiveSuggestionResolution {
  return {
    itemId: `resolve#${CONTACT}#${target}`,
    state: 'active',
    contactId: CONTACT,
    target,
    identityKey: `identity-${target}`,
    action: 'accept',
    snapshot: {
      itemId: `sugg#${CONTACT}#${target}`,
      ownerContactId: CONTACT,
      target,
      suggestedValue: 'two cats',
      conversationId: `conversation-${CONTACT}`,
      createdAt: '2026-08-25T11:00:00.000Z',
      runId: `run-${target}`,
    } as ActiveSuggestionResolution['snapshot'],
    plan: {
      kind: 'contact',
      patch: { pets: 'two cats' },
      guard: { pets: { exists: false } },
      audit: { eventType: 'suggestion_accepted', payload: { target } },
    },
    phase: 'claimed',
    leaseId: `lease-${target}`,
    // Expired well before NOW, so recovery does not skip it for free.
    leaseExpiresAt: '2026-08-25T11:30:00.000Z',
    fence: 1,
    claimedAt: '2026-08-25T11:00:00.000Z',
  };
}

/** A takeover seam that always REFUSES, recording the targets it was spent on. */
function refusingTakeover() {
  const targets: string[] = [];
  const takeover = vi.fn(async (input: { contactId: string; target: string }) => {
    targets.push(input.target);
    return { status: 'missing' } as const;
  });
  return { takeover, targets };
}

function serviceOver(journals: ActiveSuggestionResolution[]) {
  const { takeover, targets } = refusingTakeover();
  const service = createSuggestionResolutionService({
    contactsRepo: {} as ContactsRepo,
    extractionRepo: {} as ExtractionRepo,
    aiRunsRepo: {} as AiRunsRepo,
    resolutionRepo: {
      async listJournals() {
        return journals;
      },
      takeover,
    } as unknown as SuggestionResolutionRepo,
    logger: createLogger({ destination: createLogCapture().stream }),
    now: () => NOW,
  });
  return { service, takeover, targets };
}

/**
 * The service with three real journals whose takeovers all REFUSE. Returns the
 * takeover spy so a test can count ATTEMPTS rather than successes.
 */
function serviceWithThreeFailingJournals() {
  return serviceOver(['pets', 'phone', 'income'].map(expiredJournal));
}

describe('recoverAbandoned - the per-call attempt budget', () => {
  it('defaults to two attempts, so an ordinary page read still pays for at most two', async () => {
    const { service, takeover } = serviceWithThreeFailingJournals();

    const result = await service.recoverAbandoned(CONTACT);

    expect(takeover).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ recovered: 0, stateChanged: false });
  });

  it('maxAttempts widens the budget - the sweep walks the whole closed key set', async () => {
    const { service, takeover } = serviceWithThreeFailingJournals();

    const result = await service.recoverAbandoned(CONTACT, { maxAttempts: 12 });

    expect(takeover).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ recovered: 0, stateChanged: false });
  });

  it('an explicit budget of 0 attempts nothing (the option is a real bound, not a hint)', async () => {
    const { service, takeover } = serviceWithThreeFailingJournals();

    await service.recoverAbandoned(CONTACT, { maxAttempts: 0 });

    expect(takeover).not.toHaveBeenCalled();
  });

  it('an omitted maxAttempts inside an options bag still means the read-path default', async () => {
    const { service, takeover } = serviceWithThreeFailingJournals();

    await service.recoverAbandoned(CONTACT, {});

    expect(takeover).toHaveBeenCalledTimes(2);
  });

  it('a live lease is skipped for FREE - cheap skips never consume the budget', async () => {
    const { service, targets } = serviceOver([
      { ...expiredJournal('pets'), leaseExpiresAt: '2026-08-25T12:30:00.000Z' },
      expiredJournal('phone'),
      expiredJournal('income'),
    ]);

    await service.recoverAbandoned(CONTACT);

    // The live-leased journal cost nothing, so both expired ones were tried.
    expect(targets).toEqual(['phone', 'income']);
  });
});
