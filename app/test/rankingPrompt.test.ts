// WP1 B2a spec D4 "The call" and D8.1: the system text (rubric then the
// worked examples, byte-stable), the user content (anchor, homesSeen written
// once each, candidates by handle in pool order), promptFingerprint (PR18:
// sha256 over the system text, a newline and the stable JSON of the schema
// sent) and the per-pair input snapshot.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RANKING_EXAMPLES } from '../src/services/ranking/examples.js';
import {
  PROMPT_FRAMING,
  RankingPromptError,
  buildRankingBatch,
  buildRankingPrompt,
  buildRankingSystemPrompt,
  rankingPromptFingerprint,
  renderExamplesText,
  renderUserContent,
  snapshotOf,
  stableJson,
} from '../src/services/ranking/prompt.js';
import { RUBRIC_TEXT } from '../src/services/ranking/rubric.js';
import { rankingSchema } from '../src/services/ranking/schema.js';
import {
  factsOf,
  missing,
  propertiesForTenantSource,
  propertyCardFixture,
  tenantCardFixture,
  tenantsForPropertySource,
} from './helpers/rankingBatchFixture.js';

function inputJson(user: string): Record<string, unknown> {
  const lines = user.split('\n');
  expect(lines[2]).toBe('INPUT:');
  return JSON.parse(lines.slice(3).join('\n')) as Record<string, unknown>;
}

const seenEntry = (home: string) => ({
  home,
  sends: [{ at: '2026-10-01', kind: 'sent' }],
  daysSinceLastSend: 20,
  declined: null,
  tours: [],
  feedback: [],
});

describe('the system text', () => {
  it('is the rubric, then the worked examples, every example once in order', () => {
    const system = buildRankingSystemPrompt();
    expect(system.startsWith(`${RUBRIC_TEXT}\n\nWORKED EXAMPLES`)).toBe(true);
    let at = 0;
    RANKING_EXAMPLES.forEach((example, i) => {
      const heading = `EXAMPLE ${i + 1}: ${example.title}`;
      const found = system.indexOf(heading, at);
      expect(found, heading).toBeGreaterThan(at);
      at = found;
    });
  });

  it('renders each example with the real user-content renderer, then its output', () => {
    const system = buildRankingSystemPrompt();
    const first = RANKING_EXAMPLES[0]!;
    const rendered = renderUserContent(first.direction, { anchor: first.anchor, homesSeen: first.homesSeen, candidates: first.candidates });
    expect(system).toContain(`EXAMPLE 1: ${first.title}\n${rendered}\nOUTPUT:\n${JSON.stringify(first.output)}`);
  });

  it('R2F3: every framing string lives in the frozen PROMPT_FRAMING, and the system text ends with the rendered examples', () => {
    expect(Object.isFrozen(PROMPT_FRAMING)).toBe(true);
    expect(Object.isFrozen(PROMPT_FRAMING.directionLines)).toBe(true);
    expect(Object.keys(PROMPT_FRAMING.directionLines).sort()).toEqual(['properties_for_tenant', 'tenants_for_property']);
    const first = RANKING_EXAMPLES[0]!;
    const rendered = renderUserContent(first.direction, { anchor: first.anchor, homesSeen: first.homesSeen, candidates: first.candidates });
    expect(rendered.split('\n').slice(0, 3)).toEqual([
      PROMPT_FRAMING.directionLines[first.direction],
      PROMPT_FRAMING.instructionLine,
      PROMPT_FRAMING.inputLine,
    ]);
    expect(buildRankingSystemPrompt()).toBe(`${RUBRIC_TEXT}\n\n${PROMPT_FRAMING.examplesHeading}\n\n${renderExamplesText()}`);
    expect(renderExamplesText().startsWith(`${PROMPT_FRAMING.examplePrefix} 1: ${first.title}\n`)).toBe(true);
  });

  it('is byte-stable and ASCII only', () => {
    expect(buildRankingSystemPrompt()).toBe(buildRankingSystemPrompt());
    expect(buildRankingSystemPrompt()).toMatch(/^[\t\n\x20-\x7e]*$/);
  });

  it('promptFingerprint (PR18) is sha256 over the system text, a newline and the stable JSON of the schema sent', () => {
    for (const landlordCard of [false, true]) {
      const expected = createHash('sha256')
        .update(`${buildRankingSystemPrompt()}\n${stableJson(rankingSchema({ landlordCard }))}`, 'utf8')
        .digest('hex');
      expect(rankingPromptFingerprint({ landlordCard })).toBe(expected);
      expect(rankingPromptFingerprint({ landlordCard })).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(rankingPromptFingerprint({ landlordCard: true })).not.toBe(rankingPromptFingerprint({ landlordCard: false }));
  });

  it('stableJson sorts object keys at every depth and keeps array order', () => {
    expect(stableJson({ b: 1, a: { d: [2, 1], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
    expect(stableJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('buildRankingBatch - handles and the user content', () => {
  it('hands out c1..cn in pool order and never puts a record id in the text', () => {
    const batch = buildRankingBatch(tenantsForPropertySource([
      tenantCardFixture({ firstName: 'Ann' }),
      tenantCardFixture({ firstName: 'Ben' }),
      tenantCardFixture({ firstName: 'Cy' }),
    ]));
    expect(batch.handles).toEqual([
      { handle: 'c1', candidateId: 'tenant-1', unitId: 'unit-anchor' },
      { handle: 'c2', candidateId: 'tenant-2', unitId: 'unit-anchor' },
      { handle: 'c3', candidateId: 'tenant-3', unitId: 'unit-anchor' },
    ]);
    expect(batch.wire.candidates.map((c) => [c.handle, c.card['firstName']])).toEqual([['c1', 'Ann'], ['c2', 'Ben'], ['c3', 'Cy']]);
    expect(batch.user).not.toContain('tenant-1');
    expect(batch.user).not.toContain('unit-anchor');
  });

  it('the user content is the direction line, the instruction, INPUT: and the wire as JSON', () => {
    const batch = buildRankingBatch(tenantsForPropertySource([tenantCardFixture()]));
    const lines = batch.user.split('\n');
    expect(lines[0]).toBe('DIRECTION: tenants_for_property - the anchor is a property; every candidate is a tenant.');
    expect(lines[1]).toBe('Score every candidate. Return exactly one entry per candidate handle, with the handle as candidateId.');
    expect(inputJson(batch.user)).toEqual(JSON.parse(JSON.stringify(batch.wire)));
    expect(Object.keys(batch.wire)).toEqual(['anchor', 'homesSeen', 'candidates']);
    expect(Object.keys(batch.wire.candidates[0]!)).toEqual(['handle', 'card', 'missing', 'pairHistory']);
  });

  it('the tenant anchor direction line', () => {
    const batch = buildRankingBatch(propertiesForTenantSource([{ unitId: 'u-1', card: propertyCardFixture() }]));
    expect(batch.user.split('\n')[0]).toBe('DIRECTION: properties_for_tenant - the anchor is a tenant; every candidate is a property.');
  });

  it('sends missing flags as their labels', () => {
    const src = tenantsForPropertySource([tenantCardFixture()]);
    const batch = buildRankingBatch({
      ...src,
      anchor: { ...src.anchor, missing: missing('Payment standard') },
      candidates: [{ ...src.candidates[0]!, missing: missing('Area preference', 'Maximum tenant portion') }],
    });
    expect(batch.wire.anchor.missing).toEqual(['Payment standard']);
    expect(batch.wire.candidates[0]!.missing).toEqual(['Area preference', 'Maximum tenant portion']);
  });

  it('carries the system text, the fingerprint, the batch index and the landlord switch', () => {
    const batch = buildRankingBatch(tenantsForPropertySource([tenantCardFixture()], propertyCardFixture(), { batchIndex: 3, landlordCard: true }));
    expect(batch.system).toBe(buildRankingSystemPrompt());
    expect(batch.promptFingerprint).toBe(rankingPromptFingerprint({ landlordCard: true }));
    expect(batch.batchIndex).toBe(3);
    expect(batch.landlordCard).toBe(true);
  });
});

describe('buildRankingBatch - homesSeen', () => {
  const homeA = { label: '1 Seen Street, Decatur', card: propertyCardFixture({ notes: 'home A' }) };
  const homeB = { label: '2 Seen Street, Tucker', card: propertyCardFixture({ notes: 'home B' }) };

  it('writes each distinct home ONCE, h1..hn in first-reference order, and points every entry at it', () => {
    const batch = buildRankingBatch(tenantsForPropertySource(
      [
        tenantCardFixture({ propertiesSeen: [seenEntry('u-b'), seenEntry('u-a')] }),
        tenantCardFixture({ propertiesSeen: [seenEntry('u-a')] }),
      ],
      propertyCardFixture(),
      { homes: new Map([['u-a', homeA], ['u-b', homeB]]) },
    ));
    expect(batch.wire.homesSeen).toEqual([
      { handle: 'h1', label: homeB.label, card: homeB.card },
      { handle: 'h2', label: homeA.label, card: homeA.card },
    ]);
    const seen1 = batch.wire.candidates[0]!.card['propertiesSeen'] as Array<Record<string, unknown>>;
    const seen2 = batch.wire.candidates[1]!.card['propertiesSeen'] as Array<Record<string, unknown>>;
    expect(seen1.map((e) => e['home'])).toEqual(['h1', 'h2']);
    expect(seen2.map((e) => e['home'])).toEqual(['h2']);
    expect(Object.keys(seen1[0]!)).toEqual(['home', 'sends', 'daysSinceLastSend', 'declined', 'tours', 'feedback']);
    expect(batch.user).not.toContain('u-a');
  });

  it('a seen home that is also a candidate is written once, as the candidate, and referenced by its c handle', () => {
    const batch = buildRankingBatch(propertiesForTenantSource(
      [{ unitId: 'u-1', card: propertyCardFixture({ notes: 'cand 1' }) }, { unitId: 'u-2', card: propertyCardFixture({ notes: 'cand 2' }) }],
      tenantCardFixture({ propertiesSeen: [seenEntry('u-2'), seenEntry('u-9')] }),
      { homes: new Map([['u-2', { label: '2 Cand Road, Decatur', card: propertyCardFixture({ notes: 'cand 2' }) }], ['u-9', homeA]]) },
    ));
    const seen = batch.wire.anchor.card['propertiesSeen'] as Array<Record<string, unknown>>;
    expect(seen.map((e) => e['home'])).toEqual(['c2', 'h1']);
    expect(batch.wire.homesSeen).toEqual([{ handle: 'h1', label: homeA.label, card: homeA.card }]);
    expect(batch.homeLabelByHandle.get('c2')).toBe('2 Cand Road, Decatur');
    expect(batch.homeLabelByHandle.get('h1')).toBe(homeA.label);
  });

  it('PR20: a seen home that IS the property anchor is home "anchor", never written to homesSeen', () => {
    const batch = buildRankingBatch(tenantsForPropertySource(
      [tenantCardFixture({ propertiesSeen: [seenEntry('unit-anchor'), seenEntry('u-a')] })],
      propertyCardFixture(),
      { homes: new Map([['unit-anchor', { label: '10 Fixture Street, Decatur', card: propertyCardFixture() }], ['u-a', homeA]]) },
    ));
    const seen = batch.wire.candidates[0]!.card['propertiesSeen'] as Array<Record<string, unknown>>;
    expect(seen.map((e) => e['home'])).toEqual(['anchor', 'h1']);
    expect(batch.wire.homesSeen).toEqual([{ handle: 'h1', label: homeA.label, card: homeA.card }]);
    expect(batch.homeLabelByHandle.get('anchor')).toBe('10 Fixture Street, Decatur');
  });

  it('PR20 / IR17: no unitId reaches the user text, whichever of the three references an entry gets', () => {
    const tenantSide = buildRankingBatch(tenantsForPropertySource(
      [tenantCardFixture({ propertiesSeen: [seenEntry('unit-anchor'), seenEntry('u-a')] })],
      propertyCardFixture(),
      { homes: new Map([['unit-anchor', { label: '10 Fixture Street, Decatur', card: propertyCardFixture() }], ['u-a', homeA]]) },
    ));
    for (const id of ['unit-anchor', 'u-a']) expect(tenantSide.user).not.toContain(id);
    const propertySide = buildRankingBatch(propertiesForTenantSource(
      [{ unitId: 'u-1', card: propertyCardFixture() }, { unitId: 'u-2', card: propertyCardFixture() }],
      tenantCardFixture({ propertiesSeen: [seenEntry('u-2'), seenEntry('u-9')] }),
      { homes: new Map([['u-2', { label: '2 Cand Road, Decatur', card: propertyCardFixture() }], ['u-9', homeB]]) },
    ));
    for (const id of ['u-1', 'u-2', 'u-9']) expect(propertySide.user).not.toContain(id);
  });

  it('throws RankingPromptError for a home the batch does not carry', () => {
    expect(() => buildRankingBatch(tenantsForPropertySource([tenantCardFixture({ propertiesSeen: [seenEntry('u-missing')] })])))
      .toThrow(RankingPromptError);
  });

  it('leaves an entry without a string home as it is, and a card without propertiesSeen untouched', () => {
    const odd = { sends: [], feedback: ['x'] };
    const batch = buildRankingBatch(tenantsForPropertySource([tenantCardFixture({ propertiesSeen: [odd] })]));
    expect(batch.wire.candidates[0]!.card['propertiesSeen']).toEqual([odd]);
    expect(batch.wire.anchor.card).toEqual(propertyCardFixture());
  });

  it('never mutates the cards it was given', () => {
    const card = tenantCardFixture({ propertiesSeen: [seenEntry('u-a')] });
    const before = JSON.stringify(card);
    buildRankingBatch(tenantsForPropertySource([card], propertyCardFixture(), { homes: new Map([['u-a', homeA]]) }));
    expect(JSON.stringify(card)).toBe(before);
  });
});

describe('buildRankingBatch - the parse context', () => {
  it('a property anchor: every handle reads the anchor property free text', () => {
    const property = propertyCardFixture({ qualifications: 'No kids.' });
    const batch = buildRankingBatch(tenantsForPropertySource([tenantCardFixture(), tenantCardFixture()], property));
    expect(batch.freeTextByHandle.get('c1')).toEqual(factsOf(property).freeTextByField);
    expect(batch.freeTextByHandle.get('c2')).toEqual(factsOf(property).freeTextByField);
  });

  it('a tenant anchor: each handle reads its own property', () => {
    const a = propertyCardFixture({ notes: 'A' });
    const b = propertyCardFixture({ notes: 'B' });
    const batch = buildRankingBatch(propertiesForTenantSource([{ unitId: 'u-a', card: a }, { unitId: 'u-b', card: b }]));
    expect(batch.freeTextByHandle.get('c1')!['notes']).toBe('A');
    expect(batch.freeTextByHandle.get('c2')!['notes']).toBe('B');
  });
});

describe('snapshotOf (spec D8.1)', () => {
  it('holds the anchor and the candidate as sent, and every home either tenant card references, resolved', () => {
    const homeA = { label: '1 Seen Street, Decatur', card: propertyCardFixture({ notes: 'home A' }) };
    const batch = buildRankingBatch(tenantsForPropertySource(
      [tenantCardFixture({ propertiesSeen: [seenEntry('u-a')] }), tenantCardFixture()],
      propertyCardFixture(),
      { homes: new Map([['u-a', homeA]]) },
    ));
    expect(snapshotOf(batch, 'c1')).toEqual({
      direction: 'tenants_for_property',
      anchor: batch.wire.anchor,
      candidate: batch.wire.candidates[0],
      homes: [{ handle: 'h1', label: homeA.label, card: homeA.card }],
    });
    expect(snapshotOf(batch, 'c2')!.homes).toEqual([]);
    expect(snapshotOf(batch, 'c9')).toBeUndefined();
  });

  it('resolves a c handle to that candidate card with its label (tenant anchor)', () => {
    const cand = propertyCardFixture({ notes: 'cand 2' });
    const batch = buildRankingBatch(propertiesForTenantSource(
      [{ unitId: 'u-1', card: propertyCardFixture() }, { unitId: 'u-2', card: cand }],
      tenantCardFixture({ propertiesSeen: [seenEntry('u-2')] }),
      { homes: new Map([['u-2', { label: '2 Cand Road, Decatur', card: cand }]]) },
    ));
    expect(snapshotOf(batch, 'c1')!.homes).toEqual([{ handle: 'c2', label: '2 Cand Road, Decatur', card: cand }]);
  });

  it('resolves "anchor" to the anchor card with its label (property anchor, PR20)', () => {
    const anchor = propertyCardFixture({ notes: 'the anchor' });
    const batch = buildRankingBatch(tenantsForPropertySource(
      [tenantCardFixture({ propertiesSeen: [seenEntry('unit-anchor')] })],
      anchor,
      { homes: new Map([['unit-anchor', { label: '10 Fixture Street, Decatur', card: anchor }]]) },
    ));
    expect(snapshotOf(batch, 'c1')!.homes).toEqual([{ handle: 'anchor', label: '10 Fixture Street, Decatur', card: anchor }]);
  });
});

describe('buildRankingPrompt (the job-facing wrapper, plan C12)', () => {
  const source = tenantsForPropertySource([tenantCardFixture({ firstName: 'Ann' }), tenantCardFixture({ firstName: 'Ben' })]);
  const prompt = buildRankingPrompt({
    ...source,
    batchIndex: 1,
    landlordCard: false,
    candidates: source.candidates.map((c, i) => ({ ...c, display: `Tenant ${i + 1}` })),
  });

  it('wraps the batch: the same input, user text and fingerprint', () => {
    expect(prompt.batchInput).toEqual(buildRankingBatch({ ...source, batchIndex: 1 }));
    expect(prompt.userText).toBe(prompt.batchInput.user);
    expect(prompt.promptFingerprint).toBe(rankingPromptFingerprint({ landlordCard: false }));
  });

  it('lists the handles with each candidate id and display, in pool order', () => {
    expect(prompt.handles).toEqual([
      { handle: 'c1', candidateId: 'tenant-1', display: 'Tenant 1' },
      { handle: 'c2', candidateId: 'tenant-2', display: 'Tenant 2' },
    ]);
  });

  it('snapshotOf works by candidate id and throws for an id not in the batch', () => {
    expect(prompt.snapshotOf('tenant-2')).toEqual(snapshotOf(prompt.batchInput, 'c2'));
    expect(() => prompt.snapshotOf('tenant-9')).toThrow(RankingPromptError);
  });
});
