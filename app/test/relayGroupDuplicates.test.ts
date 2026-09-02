// The duplicate-relay-group detector (spec D1/D2a/D4/D6). Pure unit tests over a
// fake listRelayGroups - no DynamoDB, no network.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import { createLogger } from '../src/lib/logger.js';
import { formatPhoneForDisplay } from '../src/lib/phone.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  findOpenGroupWithSamePhones,
  samePhoneSet,
} from '../src/services/relayGroupDuplicates.js';

// KEEP the capture handle - D6 mandates a WARN on an incomplete scan, and a
// discarded handle makes that log unreachable to any assertion. RESET it per test:
// a module-scope buffer that accumulates makes the WARN assertion pass on residue
// from an earlier case, so it would be green regardless of the implementation.
let logs = createLogCapture();
let logger = createLogger({ destination: logs.stream });

beforeEach(() => {
  logs = createLogCapture();
  logger = createLogger({ destination: logs.stream });
});

/** A relay group row with just the fields the detector reads. */
function group(
  conversationId: string,
  phones: string[],
  extra: Partial<ConversationItem> = {},
): ConversationItem {
  return {
    conversationId,
    // Names are FIXED, never derived from the phone. Deriving them made the
    // "wire carries no phone" assertion below unpassable against correct code.
    participants: phones.map((phone, i) => ({ contactId: '', phone, name: NAMES[i] ?? 'Someone' })),
    last_activity_at: '2026-08-18T00:00:00.000Z',
    ...extra,
  } as unknown as ConversationItem;
}

/** listRelayGroups fake: per-status items plus a per-status truncated flag. */
function repo(
  byStatus: Partial<Record<'open' | 'connecting' | 'closed', ConversationItem[]>>,
  truncated: Partial<Record<'open' | 'connecting' | 'closed', boolean>> = {},
) {
  return {
    listRelayGroups: vi.fn(async (status: 'open' | 'connecting' | 'closed') => ({
      items: byStatus[status] ?? [],
      truncated: truncated[status] ?? false,
    })),
  };
}

const A = '+15558000001';
const B = '+15558000002';
const C = '+15558000003';
const NAMES = ['Dana Reed', 'Marcus Bell', 'Third Person'];

describe('samePhoneSet', () => {
  it('is true for the same members in a different order', () => {
    expect(samePhoneSet(new Set([A, B]), new Set([B, A]))).toBe(true);
  });

  it('is false for a superset and for a subset', () => {
    expect(samePhoneSet(new Set([A, B]), new Set([A, B, C]))).toBe(false);
    expect(samePhoneSet(new Set([A, B, C]), new Set([A, B]))).toBe(false);
  });
});

describe('findOpenGroupWithSamePhones - D1, the product rule', () => {
  it('matches an OPEN group with exactly the same phones', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-1');
    expect(found?.partition).toBe('open');
  });

  it('does NOT match when the proposed roster is a SUPERSET', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B, C])),
    ).toBeUndefined();
  });

  it('does NOT match when the proposed roster is a SUBSET', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B, C])] });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).toBeUndefined();
  });

  it('does NOT match on a partial overlap', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, C])),
    ).toBeUndefined();
  });
});

describe('findOpenGroupWithSamePhones - D4, which partitions count', () => {
  it('matches a CONNECTING group', async () => {
    const conversations = repo({ connecting: [group('conv-c', [A, B])] });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-c');
    expect(found?.partition).toBe('connecting');
  });

  it('SKIPS an imported CONNECTING row - it is an unconverted carrier group text', async () => {
    const conversations = repo({
      connecting: [group('conv-imported', [A, B], { imported_from: 'quo' } as Partial<ConversationItem>)],
    });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).toBeUndefined();
  });

  it('does NOT skip an imported OPEN row - it is a live group', async () => {
    // `imported_from` is never cleared, so an import-origin group that later went
    // live still carries the stamp. Filtering it here would silence it forever.
    const conversations = repo({
      open: [group('conv-was-imported', [A, B], { imported_from: 'quo' } as Partial<ConversationItem>)],
    });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-was-imported');
  });

  it('never reads the closed partition', async () => {
    const conversations = repo({ closed: [group('conv-closed', [A, B])] });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).toBeUndefined();
    expect(conversations.listRelayGroups).not.toHaveBeenCalledWith('closed');
  });
});

describe('findOpenGroupWithSamePhones - the tie-break', () => {
  it('prefers an OPEN match over a CONNECTING one EVEN WHEN connecting is newer', async () => {
    const conversations = repo({
      open: [group('conv-open', [A, B], { last_activity_at: '2026-08-01T00:00:00.000Z' })],
      connecting: [group('conv-conn', [A, B], { last_activity_at: '2026-08-18T00:00:00.000Z' })],
    });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-open');
  });

  it('takes the newest WITHIN a status', async () => {
    const conversations = repo({
      open: [
        group('conv-old', [A, B], { last_activity_at: '2026-08-01T00:00:00.000Z' }),
        group('conv-new', [A, B], { last_activity_at: '2026-08-17T00:00:00.000Z' }),
      ],
    });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-new');
  });
});

describe('findOpenGroupWithSamePhones - D6, a match always wins', () => {
  it('returns a match found in a walk that ALSO truncated', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] }, { open: true });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-1');
  });

  it('returns a CONNECTING match when the OPEN walk truncated and matched nothing', async () => {
    // The non-vacuous direction: OPEN is scanned FIRST, so a truncated OPEN walk
    // must not stop the CONNECTING scan that holds the real match. Asserting the
    // reverse would prove nothing - the detector returns on the first hit and
    // never reaches the second partition at all.
    const conversations = repo(
      { open: [group('conv-other', [A, C])], connecting: [group('conv-2', [A, B])] },
      { open: true },
    );
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-2');
  });

  it('returns undefined AND warns when there is NO match and a walk truncated', async () => {
    const conversations = repo({ open: [group('conv-1', [A, C])] }, { open: true });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).toBeUndefined();
    // D6 mandates the WARN. Without this assertion an implementation that
    // silently gives up passes every other case in this file.
    expect(logs.lines.some((l) => l['event'] === 'relay_duplicate_scan_incomplete')).toBe(true);
  });

  it('swallows a thrown Query and returns undefined rather than propagating', async () => {
    const conversations = {
      listRelayGroups: vi.fn(async () => {
        throw new Error('dynamo exploded');
      }),
    };
    await expect(
      findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).resolves.toBeUndefined();
  });

  it('swallows a throw from MATCHING a malformed row, not just from the read', async () => {
    // The read succeeding and the row being unusable are different failures, and an
    // earlier version guarded only the read - leaving the match/sort/shape chain
    // outside the try. Both preview routes deliberately do not catch, so a throw
    // here 500'd every relay-open preview instead of degrading to no warning.
    //
    // `participants` typed as a non-iterable is a real legacy shape: the field is
    // optional on ConversationItem and nothing validates it on read, so `for...of`
    // over it throws TypeError.
    const malformed = {
      conversationId: 'conv-legacy',
      participants: 42,
      last_activity_at: '2026-08-18T00:00:00.000Z',
    } as unknown as ConversationItem;
    const conversations = repo({ open: [malformed] });

    await expect(
      findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).resolves.toBeUndefined();
  });

  it('still matches a GOOD row in the other partition when one partition throws', async () => {
    // The degradation must be per-partition, not global: a bad row in OPEN must not
    // cost the operator a warning that CONNECTING can still supply.
    const malformed = {
      conversationId: 'conv-legacy',
      participants: 42,
      last_activity_at: '2026-08-18T00:00:00.000Z',
    } as unknown as ConversationItem;
    const conversations = repo({
      open: [malformed],
      connecting: [group('conv-good', [A, B])],
    });

    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.conversationId).toBe('conv-good');
  });
});

describe('findOpenGroupWithSamePhones - D2a, the adjacent-field trap', () => {
  it('compares participants, NOT ever_member_phones', async () => {
    // A group whose PROVENANCE is {A,B} but whose live roster is {A,C}. Comparing
    // ever_member_phones would match; comparing participants must not.
    const row = group('conv-drifted', [A, C], {
      ever_member_phones: new Set([A, B]),
    } as Partial<ConversationItem>);
    const conversations = repo({ open: [row] });
    expect(
      await findOpenGroupWithSamePhones({ conversations, log: logger }, new Set([A, B])),
    ).toBeUndefined();
  });
});

describe('findOpenGroupWithSamePhones - the wire rule', () => {
  it('returns member NAMES when it has them', async () => {
    const conversations = repo({ open: [group('conv-1', [A, B])] });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.memberNames).toEqual(['Dana Reed', 'Marcus Bell']);
    // A named member's number never appears - a name is always preferred.
    expect(JSON.stringify(found)).not.toContain(A);
    expect(JSON.stringify(found)).not.toContain(B);
  });

  it('names ONLY the phone-bearing participants the match was made on', async () => {
    // The asymmetry this pins: the match is decided on participants that HAVE a
    // phone, so the copy must be too. A stored row really can carry a blank phone
    // (participants are unvalidated casts off DynamoDB), and naming that person
    // tells the operator the existing group holds somebody who is not in the set
    // that matched at all.
    const row = {
      conversationId: 'conv-1',
      participants: [
        { contactId: '', phone: A, name: 'Dana Reed' },
        { contactId: '', phone: B, name: 'Marcus Bell' },
        { contactId: '', phone: '', name: 'Renee Carter' },
      ],
      last_activity_at: '2026-08-18T00:00:00.000Z',
    } as unknown as ConversationItem;
    const conversations = repo({ open: [row] });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    // The two-phone roster still MATCHES - the phoneless row is not a member.
    expect(found?.conversationId).toBe('conv-1');
    expect(found?.memberNames).toEqual(['Dana Reed', 'Marcus Bell']);
  });

  it('renders a nameless participant as their FORMATTED PHONE, never "Unknown"', async () => {
    // The founder ruling 2026-08-19: this warning is STAFF CHROME - it renders
    // only in the navigator's confirm dialog and is transmitted to nobody - so it
    // owes the navigator something actionable. 'Unknown already has an open relay
    // group' names nobody they can look up or call.
    //
    // The outbound half is unaffected and stays that way: the intro body a tenant
    // actually receives still drops a nameless member (relayFanOut
    // composeNameList), pinned by the preview-body guard in
    // app/test/rosterEdits.test.ts.
    const row = {
      conversationId: 'conv-1',
      participants: [{ contactId: '', phone: A }, { contactId: '', phone: B, name: 'Bee' }],
      last_activity_at: '2026-08-18T00:00:00.000Z',
    } as unknown as ConversationItem;
    const conversations = repo({ open: [row] });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.memberNames).toEqual([formatPhoneForDisplay(A), 'Bee']);
    expect(found?.memberNames[0]).toBe('(555) 800-0001');
    // Assert the FORMATTED form specifically: the raw E.164 is what a log line or
    // a message body would carry, and it must not be what a label carries.
    expect(JSON.stringify(found)).not.toContain(A);
  });

  it('treats a whitespace-only name as no name', async () => {
    const row = {
      conversationId: 'conv-1',
      participants: [
        { contactId: '', phone: A, name: '   ' },
        { contactId: '', phone: B, name: 'Bee' },
      ],
      last_activity_at: '2026-08-18T00:00:00.000Z',
    } as unknown as ConversationItem;
    const conversations = repo({ open: [row] });
    const found = await findOpenGroupWithSamePhones(
      { conversations, log: logger },
      new Set([A, B]),
    );
    expect(found?.memberNames).toEqual(['(555) 800-0001', 'Bee']);
  });
});
