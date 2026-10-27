// WP1 B1 spec D5.1 / D5.3: the PROPERTIES SENT block of the extraction USER
// content - which rows, the one-line label, flyer sign-ups, identical labels
// once, the TRANSCRIPT and budget drops, "none", the fingerprint - and the run
// record's feedback counts over the lines a run appended.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Address } from '../src/lib/address.js';
import type { ListingSendItem, ShareLedgerEntry } from '../src/repos/listingSendsRepo.js';
import {
  SENT_PROPERTIES_BLOCK_BUDGET,
  SENT_PROPERTIES_BLOCK_HEADER,
  SENT_PROPERTIES_MAX_ROWS,
  countFeedbackLines,
  renderSentPropertiesBlock,
  selectSentRows,
  type SentPropertyEntry,
} from '../src/services/extraction/sentPropertiesBlock.js';

const MAIN: Address = { line1: '123 Main St', city: 'Decatur', state: 'GA' };
const OAK: Address = { line1: '9 Oak Ave', line2: 'Apt 2', city: 'Atlanta', state: 'GA' };
const ELM: Address = { line1: '40 Elm Rd', city: 'Marietta', state: 'GA' };

function entry(address: Address | undefined, sentAt: string, signedUp = false): SentPropertyEntry {
  return { unit: address === undefined ? {} : { address }, sentAt, signedUp };
}

describe('selectSentRows', () => {
  const counted = (attempt: string, countedAt: string): ShareLedgerEntry => ({
    attempt,
    state: 'counted',
    by: 'acceptance',
    countedAt,
  });
  function row(
    unitId: string,
    sentAt: string | undefined,
    shares?: Record<string, ShareLedgerEntry>,
  ): Pick<ListingSendItem, 'unitId' | 'sentAt' | 'shares'> {
    return { unitId, ...(sentAt !== undefined && { sentAt }), ...(shares !== undefined && { shares }) };
  }

  it('keeps the newest 20 by sentAt, newest first, whatever order the rows arrive in', () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row(`u-${String(i).padStart(2, '0')}`, `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`),
    );
    const picked = selectSentRows([...rows.slice(10), ...rows.slice(0, 10)]);
    expect(SENT_PROPERTIES_MAX_ROWS).toBe(20);
    expect(picked).toHaveLength(20);
    expect(picked[0]).toEqual({ unitId: 'u-24', sentAt: '2026-07-25T10:00:00.000Z', signedUp: false });
    expect(picked[19]!.unitId).toBe('u-05');
  });

  it('skips a row with no sentAt (an unlisted row carries none)', () => {
    expect(selectSentRows([row('u-1', undefined), row('u-2', '2026-07-02T10:00:00.000Z')]).map((r) => r.unitId)).toEqual(['u-2']);
  });

  it('is signed up exactly when the LATEST counted share is the flyer entry', () => {
    const flyer = counted('2026-07-10T10:00:00.000Z#flyer', '2026-07-10T10:00:00.000Z');
    const earlierBroadcast = counted('2026-07-01T10:00:00.000Z#b-1', '2026-07-01T10:00:00.000Z');
    const laterBroadcast = counted('2026-07-20T10:00:00.000Z#b-2', '2026-07-20T10:00:00.000Z');
    const picked = selectSentRows([
      row('flyer-only', '2026-07-10T10:00:00.000Z', { flyer }),
      row('flyer-latest', '2026-07-10T10:00:00.000Z', { 'b-1': earlierBroadcast, flyer }),
      row('broadcast-latest', '2026-07-20T10:00:00.000Z', { flyer, 'b-2': laterBroadcast }),
      row('legacy', '2026-07-05T10:00:00.000Z'),
    ]);
    expect(Object.fromEntries(picked.map((r) => [r.unitId, r.signedUp]))).toEqual({
      'flyer-only': true,
      'flyer-latest': true,
      'broadcast-latest': false,
      legacy: false,
    });
  });
});

describe('renderSentPropertiesBlock - shape', () => {
  it('a header, then one line per property, newest first: "sent" or "signed up" and the YYYY-MM-DD date', () => {
    const block = renderSentPropertiesBlock([
      entry(OAK, '2026-07-01T10:00:00.000Z'),
      entry(MAIN, '2026-07-15T23:30:00.000Z', true),
    ]);
    expect(SENT_PROPERTIES_BLOCK_HEADER).toBe('PROPERTIES SENT');
    expect(block.text).toBe([
      'PROPERTIES SENT',
      '- 123 Main St, Decatur - signed up 2026-07-15',
      '- 9 Oak Ave Apt 2, Atlanta - sent 2026-07-01',
    ].join('\n'));
    expect(block.labels).toEqual(['123 Main St, Decatur', '9 Oak Ave Apt 2, Atlanta']);
    expect(block.dropped).toEqual({ transcript: 0, budget: 0 });
    expect(block.unlabeled).toBe(0);
  });

  it('renders "PROPERTIES SENT: none" when there is nothing to list', () => {
    const block = renderSentPropertiesBlock([]);
    expect(block.text).toBe('PROPERTIES SENT: none');
    expect(block.labels).toEqual([]);
  });

  it('leaves out a property with no label (line 1 or city empty, or a legacy string) - counted, never rendered', () => {
    const block = renderSentPropertiesBlock([
      entry({ line1: '  ', city: 'Decatur' }, '2026-07-04T10:00:00.000Z'),
      entry({ line1: '5 Pine Ct' }, '2026-07-03T10:00:00.000Z'),
      { unit: { address: '5 Pine Ct, Decatur' }, sentAt: '2026-07-02T10:00:00.000Z', signedUp: false },
      entry(undefined, '2026-07-01T10:00:00.000Z'),
    ]);
    expect(block.text).toBe('PROPERTIES SENT: none');
    expect(block.unlabeled).toBe(4);
    expect(block.text).not.toContain(', Decatur');
  });

  it('renders two properties with IDENTICAL labels once - the newest send', () => {
    const block = renderSentPropertiesBlock([
      entry(MAIN, '2026-07-01T10:00:00.000Z'),
      entry(MAIN, '2026-07-09T10:00:00.000Z', true),
    ]);
    expect(block.text).toBe('PROPERTIES SENT\n- 123 Main St, Decatur - signed up 2026-07-09');
    expect(block.labels).toEqual(['123 Main St, Decatur']);
  });

  it('renders every property on ONE line - a newline inside an address part becomes a space', () => {
    const block = renderSentPropertiesBlock([entry({ line1: '123 Main St\nApt 9', city: 'Decatur' }, '2026-07-01T10:00:00.000Z')]);
    expect(block.text.split('\n')).toEqual(['PROPERTIES SENT', '- 123 Main St Apt 9, Decatur - sent 2026-07-01']);
  });

  it('does not depend on the input order', () => {
    const entries = [entry(OAK, '2026-07-01T10:00:00.000Z'), entry(MAIN, '2026-07-15T10:00:00.000Z'), entry(ELM, '2026-07-08T10:00:00.000Z')];
    const a = renderSentPropertiesBlock(entries);
    const b = renderSentPropertiesBlock([...entries].reverse());
    expect(b.text).toBe(a.text);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it('fingerprint is the sha256 hex of the text and changes with the list', () => {
    const block = renderSentPropertiesBlock([entry(MAIN, '2026-07-15T10:00:00.000Z')]);
    expect(block.fingerprint).toBe(createHash('sha256').update(block.text, 'utf8').digest('hex'));
    expect(block.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(renderSentPropertiesBlock([entry(MAIN, '2026-07-16T10:00:00.000Z')]).fingerprint).not.toBe(block.fingerprint);
  });
});

describe('renderSentPropertiesBlock - the TRANSCRIPT rule and the budget', () => {
  it('never contains the word TRANSCRIPT: such a line is left out and counted, not as a budget drop', () => {
    const block = renderSentPropertiesBlock([
      entry({ line1: '1 Transcript Way', city: 'Decatur' }, '2026-07-15T10:00:00.000Z'),
      entry(MAIN, '2026-07-01T10:00:00.000Z'),
    ]);
    expect(block.text).not.toMatch(/transcript/i);
    expect(block.text).toBe('PROPERTIES SENT\n- 123 Main St, Decatur - sent 2026-07-01');
    expect(block.dropped).toEqual({ transcript: 1, budget: 0 });
    expect(block.labels).toEqual(['123 Main St, Decatur']);
  });

  it('the default budget is 4,000 characters and holds 20 ordinary properties', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      entry({ line1: `${100 + i} Peachtree Industrial Blvd`, line2: `Unit ${i}`, city: 'Chamblee' }, `2026-07-${String(i + 1).padStart(2, '0')}T10:00:00.000Z`),
    );
    const block = renderSentPropertiesBlock(entries);
    expect(SENT_PROPERTIES_BLOCK_BUDGET).toBe(4_000);
    expect(block.dropped).toEqual({ transcript: 0, budget: 0 });
    expect(block.labels).toHaveLength(20);
    expect(block.text.length).toBeLessThanOrEqual(SENT_PROPERTIES_BLOCK_BUDGET);
  });

  it('over budget, the OLDEST properties are left out first, and the text stays within the budget', () => {
    const entries = [entry(MAIN, '2026-07-15T10:00:00.000Z'), entry(OAK, '2026-07-08T10:00:00.000Z'), entry(ELM, '2026-07-01T10:00:00.000Z')];
    const full = renderSentPropertiesBlock(entries).text.length;
    const block = renderSentPropertiesBlock(entries, { budget: full - 1 });
    expect(block.text.length).toBeLessThanOrEqual(full - 1);
    expect(block.labels).toEqual(['123 Main St, Decatur', '9 Oak Ave Apt 2, Atlanta']);
    expect(block.dropped).toEqual({ transcript: 0, budget: 1 });
  });

  it('once a line does not fit, no OLDER line is added, even a shorter one that would', () => {
    const newest = entry(MAIN, '2026-07-15T10:00:00.000Z');
    const long = entry({ line1: `77 ${'Long '.repeat(30)}Rd`, city: 'Atlanta' }, '2026-07-08T10:00:00.000Z');
    const oldest = entry(ELM, '2026-07-01T10:00:00.000Z');
    const newestLine = '- 123 Main St, Decatur - sent 2026-07-15';
    const oldestLine = '- 40 Elm Rd, Marietta - sent 2026-07-01';
    const budget = SENT_PROPERTIES_BLOCK_HEADER.length + 1 + newestLine.length + 1 + oldestLine.length;
    const block = renderSentPropertiesBlock([newest, long, oldest], { budget });
    expect(block.text).toBe(`PROPERTIES SENT\n${newestLine}`);
    expect(block.dropped).toEqual({ transcript: 0, budget: 2 });
  });
});

describe('countFeedbackLines (spec D5.3)', () => {
  const labels = ['123 Main St, Decatur', '9 Oak Ave Apt 2, Atlanta'];

  it('counts a free-form line naming a block label as feedback, the model punctuation folded', () => {
    expect(countFeedbackLines([
      '123 Main St, Decatur: on the fence - likes the yard',
      'Loved 9 Oak Ave, Apt 2, Atlanta but the rent is high',
      'No to 123 MAIN ST. DECATUR, too far from work',
    ], labels)).toEqual({ feedbackLines: 3, unlabeledAddressLines: 0 });
  });

  it('counts a line with a street address that names no block label as unlabeled', () => {
    expect(countFeedbackLines(['Asked whether 77 Pine Rd takes pets', 'Toured 123 Main Street, Decatur'], labels)).toEqual({
      feedbackLines: 0,
      unlabeledAddressLines: 2,
    });
  });

  it('counts neither for an ordinary line, and a line naming a label counts once, as feedback', () => {
    expect(countFeedbackLines([
      'Works nights downtown',
      'Household of 4',
      'Prefers 3 bedrooms',
      '123 Main St, Decatur: no - wants 40 Elm Rd instead',
    ], labels)).toEqual({ feedbackLines: 1, unlabeledAddressLines: 0 });
  });

  it('with no block labels nothing is feedback', () => {
    expect(countFeedbackLines(['123 Main St, Decatur: likes it'], [])).toEqual({ feedbackLines: 0, unlabeledAddressLines: 1 });
  });
});
