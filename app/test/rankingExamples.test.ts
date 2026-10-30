// WP1 B2a spec D4: about ten SYNTHETIC worked examples spread across the
// bands, including a capped pair, an accommodation pair (assistance animal
// against No pets), an unlawful-requirement pair, a maybe pair and a pair
// with missing inputs. Made-up people and addresses only. Each output must
// survive the production parser untouched (so the examples teach exactly
// the shape the parser keeps) and agree with the production cap and bands.
import { describe, expect, it } from 'vitest';
import { TENANT_MATCHING_INPUTS } from '../src/lib/tenantMatchingInputs.js';
import { bandOf } from '../src/services/ranking/bands.js';
import { capOf, flagFieldsOfKind } from '../src/services/ranking/cap.js';
import { EXAMPLES_VERSION, RANKING_EXAMPLES, type RankingExample } from '../src/services/ranking/examples.js';
import { parseRankingText } from '../src/services/ranking/parse.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import {
  PROPERTY_CARD_FIELDS,
  PROPERTY_FREE_TEXT_FIELDS,
  RANKED_REQUIREMENT_KEYS,
  TENANT_CARD_FIELDS,
  includedFields,
  type CardFieldUse,
} from '../src/services/ranking/cardFields.js';
import { LANDLORD_DEFAULTS_KEY, LAST_HEARD_FROM_KEY, PROPERTIES_SEEN_KEY, type PropertyCardCtx } from '../src/services/ranking/cards.js';
import { propertyMissing, tenantMissing } from '../src/services/ranking/completeness.js';
import { authorityAllows, mapAuthorities, pairAuthorityFact } from '../src/services/ranking/pool.js';
import { renderExamplesText } from '../src/services/ranking/prompt.js';
import { authoritiesOf } from '../src/lib/unitFields.js';

type Card = Record<string, unknown>;

function propertyCardOf(example: RankingExample, handle: string): Card {
  if (example.direction === 'tenants_for_property') return example.anchor.card;
  return example.candidates.find((c) => c.handle === handle)!.card;
}

function tenantCardOf(example: RankingExample, handle: string): Card {
  if (example.direction === 'properties_for_tenant') return example.anchor.card;
  return example.candidates.find((c) => c.handle === handle)!.card;
}

function freeText(card: Card): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of PROPERTY_FREE_TEXT_FIELDS) {
    const value = card[field];
    if (typeof value === 'string' && value.trim().length > 0) out[field] = value.trim();
  }
  return out;
}

function recordedKeys(card: Card): string[] {
  return RANKED_REQUIREMENT_KEYS.filter((key) => {
    const value = card[key];
    return value === true || typeof value === 'number' || (typeof value === 'string' && value.trim().length > 0);
  });
}

function everyKey(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => everyKey(v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      everyKey(child, out);
    }
  }
  return out;
}

const pairs = RANKING_EXAMPLES.flatMap((example) =>
  example.output.candidates.map((out) => ({ example, out, property: propertyCardOf(example, out.candidateId), tenant: tenantCardOf(example, out.candidateId) })),
);

function capped(p: (typeof pairs)[number]): boolean {
  return capOf({
    failedRequirements: p.out.failedRequirements,
    accommodationFields: flagFieldsOfKind(p.out.fairHousingFlags, 'accommodation'),
    recordedRequirementKeys: recordedKeys(p.property),
    openUnlawfulFields: flagFieldsOfKind(p.out.fairHousingFlags, 'unlawful'),
  }).capped;
}

describe('the worked examples (e4)', () => {
  it('is version e4 with twelve examples', () => {
    expect(EXAMPLES_VERSION).toBe('e4');
    expect(RANKING_EXAMPLES).toHaveLength(12);
  });

  // e3 (charter section 20 item 18): a TENANT-anchor rent-gap pair whose Notes
  // carry a gender-identity line beside an ordinary preference line. It scores
  // as the pair would without that line; no reason or unknown mentions it.
  it('has a tenant-anchor rent-gap pair with a gender-identity Notes line that is never a reason', () => {
    const matches = pairs.filter((x) => /\btrans\b|she\/her/i.test(String(x.tenant['notes'])));
    expect(matches).toHaveLength(1);
    const p = matches[0]!;
    expect(p.example.direction).toBe('properties_for_tenant');
    const notesLines = String(p.tenant['notes']).split('\n');
    expect(notesLines.length).toBeGreaterThanOrEqual(2);
    expect(notesLines.some((line) => !/\btrans\b|she\/her/i.test(line))).toBe(true);
    expect(Number(p.property['rent_min'])).toBeGreaterThan(Number(p.property['payment_standard']));
    expect(p.out.against.some((r) => r.source === 'rent')).toBe(true);
    const text = [...p.out.for, ...p.out.against].map((r) => r.text).concat(p.out.unknowns).join(' | ');
    expect(text).not.toMatch(/trans|gender|identity|she|her\b|woman/i);
    expect(p.out.fairHousingFlags).toEqual([]);
    expect(capped(p)).toBe(false);
  });

  // Charter section 20 item 18: no example card names a housing authority;
  // each candidate carries the pair fact the pool would give it.
  it('no example card names a housing authority, and the rendered examples carry none of the offCard names', () => {
    const rendered = renderExamplesText();
    for (const example of RANKING_EXAMPLES) {
      const cards = [example.anchor.card, ...example.candidates.map((c) => c.card), ...example.homesSeen.map((h) => h.card)];
      for (const card of cards) {
        expect(card, example.title).not.toHaveProperty('housingAuthority');
        expect(card, example.title).not.toHaveProperty('authorities');
        expect(card, example.title).not.toHaveProperty('accepted_authorities');
      }
      for (const stored of Object.values(example.offCard ?? {})) {
        for (const name of [stored['accepted_authorities'], stored['housingAuthority']].flat()) {
          if (typeof name === 'string') expect(rendered, example.title).not.toContain(name);
        }
      }
    }
    expect(rendered).not.toContain('Housing Authority');
    expect(rendered).not.toContain('offCard');
  });

  // Charter section 20 item 19: no example TENANT card carries a name or a
  // current address (the stored record keeps them, in offCard); a property
  // card keeps its own address.
  it('no example tenant card carries a name or current address, and the rendered examples carry none of them', () => {
    const rendered = renderExamplesText();
    for (const example of RANKING_EXAMPLES) {
      const anchorIsProperty = example.direction === 'tenants_for_property';
      const tenants = anchorIsProperty
        ? example.candidates.map((c) => [c.card, c.handle] as const)
        : [[example.anchor.card, 'anchor'] as const];
      for (const [card, owner] of tenants) {
        for (const key of ['firstName', 'lastName', 'address']) expect(card, `${example.title}: ${owner}`).not.toHaveProperty(key);
        const stored = example.offCard?.[owner] ?? {};
        expect(typeof stored['firstName'], `${example.title}: ${owner}`).toBe('string');
        const fullName = `${String(stored['firstName'])} ${String(stored['lastName'])}`;
        expect(rendered, example.title).not.toContain(fullName);
        expect(rendered.split(/[^A-Za-z]+/), example.title).not.toContain(stored['firstName']);
        const line1 = (stored['address'] as { line1?: string } | undefined)?.line1;
        if (line1 !== undefined) expect(rendered, example.title).not.toContain(JSON.stringify(line1));
      }
      const properties = anchorIsProperty ? [example.anchor.card] : example.candidates.map((c) => c.card);
      for (const card of properties) expect(card, example.title).toHaveProperty('address');
    }
  });

  it('every candidate authority fact is what the pool gives that stored pair (pairAuthorityFact), and the pair passes the fence', () => {
    for (const example of RANKING_EXAMPLES) {
      const anchorIsProperty = example.direction === 'tenants_for_property';
      for (const c of example.candidates) {
        const unitRecord = unitOf(anchorIsProperty ? example.anchor.card : c.card, anchorIsProperty ? 'anchor' : c.handle, example);
        const contactRecord = contactOf(anchorIsProperty ? c.card : example.anchor.card, anchorIsProperty ? c.handle : 'anchor', example);
        const mapping = mapAuthorities(ORG_ENTRIES, authoritiesOf(unitRecord));
        expect(c.authority, `${example.title}: ${c.handle}`).toBe(pairAuthorityFact(mapping));
        expect(authorityAllows(mapping, contactRecord['housingAuthority']), `${example.title}: ${c.handle}`).toBe(true);
      }
    }
  });

  // e2 (charter section 20 item 17): a rent-gap pair whose Notes carry a
  // credit and income line. It is scored from rent, the payment standard and
  // the maximum portion; no reason names credit or income.
  it('has a rent-over-payment-standard pair with a credit and income Notes line that is not a reason', () => {
    const p = pairs.find((x) => /credit/i.test(String(x.tenant['notes'])) && /income/i.test(String(x.tenant['notes'])));
    expect(p).toBeDefined();
    expect(Number(p!.property['rent_min'])).toBeGreaterThan(Number(p!.property['payment_standard']));
    expect(typeof p!.tenant['Maximum tenant portion']).toBe('number');
    expect(p!.out.against.some((r) => r.source === 'rent')).toBe(true);
    const text = [...p!.out.for, ...p!.out.against].map((r) => r.text).concat(p!.out.unknowns).join(' | ');
    expect(text).not.toMatch(/credit|income/i);
    expect(capped(p!)).toBe(false);
    expect(p!.out.failedRequirements).toEqual([]);
  });

  it('covers every band and both directions', () => {
    expect(new Set(pairs.map((p) => bandOf(p.out.score)))).toEqual(new Set(['strong', 'good', 'possible', 'weak']));
    expect(new Set(RANKING_EXAMPLES.map((e) => e.direction))).toEqual(new Set(['tenants_for_property', 'properties_for_tenant']));
  });

  it('every output survives the production parser untouched', () => {
    for (const example of RANKING_EXAMPLES) {
      const handles = example.candidates.map((c) => c.handle);
      const result = parseRankingText(JSON.stringify(example.output), {
        handles,
        freeTextByHandle: new Map(handles.map((h) => [h, freeText(propertyCardOf(example, h))])),
        landlordCard: false,
      });
      expect(result.ok, example.title).toBe(true);
      if (!result.ok) continue;
      expect(result.value.droppedUnlawfulFlags, example.title).toBe(0);
      expect(result.value.byHandle.size, example.title).toBe(example.candidates.length);
      for (const out of example.output.candidates) {
        const { candidateId: _id, ...rest } = out;
        expect(result.value.byHandle.get(out.candidateId), example.title).toEqual(rest);
      }
    }
  });

  it('candidate handles are c1..cn and home handles h1..hn, in order', () => {
    for (const example of RANKING_EXAMPLES) {
      expect(example.candidates.map((c) => c.handle)).toEqual(example.candidates.map((_c, i) => `c${i + 1}`));
      expect(example.homesSeen.map((h) => h.handle)).toEqual(example.homesSeen.map((_h, i) => `h${i + 1}`));
    }
  });

  it('a capped pair sits in Weak; there are at least two (one a qualifications clause with credit and income in it)', () => {
    const cappedPairs = pairs.filter(capped);
    expect(cappedPairs.length).toBeGreaterThanOrEqual(2);
    for (const p of cappedPairs) expect(bandOf(p.out.score), p.example.title).toBe('weak');
    expect(cappedPairs.some((p) => p.out.failedRequirements.includes('no_pets'))).toBe(true);
    expect(cappedPairs.some((p) => p.out.failedRequirements.includes('qualifications') && /credit/i.test(String(p.property['qualifications'])))).toBe(true);
  });

  it('has an accommodation pair: assistance animal against No pets, not capped', () => {
    const p = pairs.find((x) => x.out.fairHousingFlags.some((f) => f.kind === 'accommodation' && f.field === 'no_pets'));
    expect(p).toBeDefined();
    expect(p!.property['no_pets']).toBe(true);
    expect(String(p!.tenant['pets'])).toMatch(/assistance animal/i);
    expect(capped(p!)).toBe(false);
    expect(p!.out.failedRequirements).toEqual([]);
  });

  it('has an unlawful pair: a no-kids rule flagged on a free-text field, noted in unknowns, not capped, not failed', () => {
    const p = pairs.find((x) => x.out.fairHousingFlags.some((f) => f.kind === 'unlawful'));
    expect(p).toBeDefined();
    const flag = p!.out.fairHousingFlags.find((f) => f.kind === 'unlawful')!;
    expect(PROPERTY_FREE_TEXT_FIELDS).toContain(flag.field);
    expect(String(p!.property[flag.field])).toMatch(/no kids/i);
    expect(p!.out.unknowns.some((u) => u.startsWith(`${flag.field}:`))).toBe(true);
    expect(p!.out.failedRequirements).not.toContain(flag.field);
    expect(capped(p!)).toBe(false);
  });

  it('has a maybe pair: a staff decline plus unsure feedback, scored above Weak', () => {
    const p = pairs.find((x) => {
      const history = x.example.candidates.find((c) => c.handle === x.out.candidateId)!.pairHistory;
      return history.declined !== null;
    });
    expect(p).toBeDefined();
    const seen = p!.tenant['propertiesSeen'] as Array<{ feedback: string[] }>;
    expect(seen.some((s) => s.feedback.some((line) => /on the fence/i.test(line)))).toBe(true);
    expect(bandOf(p!.out.score)).not.toBe('weak');
  });

  it('has a pair with missing inputs on both cards', () => {
    expect(RANKING_EXAMPLES.some((e) => e.anchor.missing.length > 0 && e.candidates.some((c) => c.missing.length > 0))).toBe(true);
  });

  it('has a Weak pair that is NOT capped (an accessibility need the home cannot meet)', () => {
    expect(pairs.some((p) => bandOf(p.out.score) === 'weak' && !capped(p) && p.out.against.some((r) => r.source === 'accessibility'))).toBe(true);
  });

  it('every home a propertiesSeen entry names is in homesSeen, is a candidate, or is the property anchor (PR20)', () => {
    for (const example of RANKING_EXAMPLES) {
      const handles = new Set([...example.homesSeen.map((h) => h.handle), ...example.candidates.map((c) => c.handle)]);
      if (example.direction === 'tenants_for_property') handles.add('anchor');
      const cards = [example.anchor.card, ...example.candidates.map((c) => c.card)];
      for (const card of cards) {
        const seen = card['propertiesSeen'];
        if (!Array.isArray(seen)) continue;
        for (const entry of seen as Array<{ home: string }>) expect(handles.has(entry.home), example.title).toBe(true);
      }
    }
  });

  // PR31 / R2F13: the examples are the production wire shape. Each card's
  // `missing` is what S3's OWN completeness functions (propertyMissing /
  // tenantMissing) return for the stored record the card was built from;
  // each card key is one the card builders can emit; each seen entry has
  // the keys S3's tenant card writes; and the three home references (h, c,
  // anchor) all appear.
  const DERIVED_PROPERTY_KEYS = ['voucherSizes', 'voucherSizesInferredFromBeds', LANDLORD_DEFAULTS_KEY];
  const DERIVED_TENANT_KEYS = [LAST_HEARD_FROM_KEY, PROPERTIES_SEEN_KEY];
  const ORG_ENTRIES = buildStartingEntries('2026-10-28T00:00:00.000Z', (() => { let n = 0; return () => `ex-org-${(n += 1)}`; })());
  const CTX: PropertyCardCtx = { orgEntries: ORG_ENTRIES, landlordCard: false, landlord: null };

  /** The stored attributes the card leaves off (charter section 20 item 18), never rendered. */
  const offCardOf = (example: RankingExample, owner: string): Card => example.offCard?.[owner] ?? {};

  /** The stored unit an example property card stands for (the card's own keys, derived fields undone, plus its offCard). */
  function unitOf(card: Card, owner: string, example: RankingExample): UnitItem {
    const record: Record<string, unknown> = { unitId: 'ex-unit', landlordId: 'ex-landlord' };
    for (const [key, value] of Object.entries(card)) if (!DERIVED_PROPERTY_KEYS.includes(key)) record[key] = value;
    if (card['voucherSizesInferredFromBeds'] !== true) record['voucher_size_accepted'] = card['voucherSizes'];
    Object.assign(record, offCardOf(example, owner));
    return record as UnitItem;
  }

  /** The stored contact an example tenant card stands for (list labels mapped back to their keys, plus its offCard). */
  function contactOf(card: Card, owner: string, example: RankingExample): ContactItem {
    const record: Record<string, unknown> = { contactId: 'ex-contact', type: 'tenant' };
    const keyOfLabel = new Map<string, string>(TENANT_MATCHING_INPUTS.map((e) => [e.label, e.key]));
    for (const [key, value] of Object.entries(card)) {
      if (DERIVED_TENANT_KEYS.includes(key)) continue;
      record[keyOfLabel.get(key) ?? key] = value;
    }
    Object.assign(record, offCardOf(example, owner));
    return record as ContactItem;
  }

  const labels = (flags: readonly { label: string }[]): string[] => flags.map((f) => f.label);
  const propertyFlags = (card: Card, owner: string, example: RankingExample): string[] =>
    labels(propertyMissing(unitOf(card, owner, example), CTX));
  const tenantFlags = (card: Card, owner: string, example: RankingExample): string[] =>
    labels(tenantMissing(contactOf(card, owner, example)));

  const emittedKeys = (registry: Readonly<Record<string, CardFieldUse>>): Set<string> =>
    new Set(includedFields(registry).map(([key, field]) => field.cardKey ?? key));

  it('every example card key is one the production card builders can emit (R2F13)', () => {
    const propertyKeys = new Set([...emittedKeys(PROPERTY_CARD_FIELDS), ...DERIVED_PROPERTY_KEYS]);
    const tenantKeys = new Set([...emittedKeys(TENANT_CARD_FIELDS), ...DERIVED_TENANT_KEYS]);
    for (const example of RANKING_EXAMPLES) {
      const anchorIsProperty = example.direction === 'tenants_for_property';
      const check = (card: Card, allowed: Set<string>, who: string): void => {
        for (const key of Object.keys(card)) expect(allowed.has(key), `${example.title}: ${who} key ${key}`).toBe(true);
      };
      check(example.anchor.card, anchorIsProperty ? propertyKeys : tenantKeys, 'anchor');
      for (const c of example.candidates) check(c.card, anchorIsProperty ? tenantKeys : propertyKeys, c.handle);
      for (const h of example.homesSeen) check(h.card, propertyKeys, h.handle);
    }
  });

  it('every missing list is what S3\'s propertyMissing / tenantMissing return for that card\'s record (PR31, R2F13)', () => {
    for (const example of RANKING_EXAMPLES) {
      const anchorIsProperty = example.direction === 'tenants_for_property';
      expect(example.anchor.missing, `${example.title}: anchor`).toEqual(
        anchorIsProperty ? propertyFlags(example.anchor.card, 'anchor', example) : tenantFlags(example.anchor.card, 'anchor', example),
      );
      for (const c of example.candidates) {
        expect(c.missing, `${example.title}: ${c.handle}`).toEqual(
          anchorIsProperty ? tenantFlags(c.card, c.handle, example) : propertyFlags(c.card, c.handle, example),
        );
      }
    }
  });

  it('every seen entry has the keys S3 writes, in order, and the label of its home (PR31)', () => {
    for (const example of RANKING_EXAMPLES) {
      const tenantCards = example.direction === 'tenants_for_property' ? example.candidates.map((c) => c.card) : [example.anchor.card];
      for (const card of tenantCards) {
        for (const entry of (card['propertiesSeen'] as Array<Record<string, unknown>>) ?? []) {
          expect(Object.keys(entry), example.title).toEqual(['home', 'label', 'sends', 'daysSinceLastSend', 'declined', 'tours', 'feedback']);
          const seenHome = example.homesSeen.find((h) => h.handle === entry['home']);
          if (seenHome !== undefined) expect(entry['label']).toBe(seenHome.label);
        }
      }
    }
  });

  it('the examples use all three home references: an h handle, a c handle and the anchor (PR20, PR31)', () => {
    const refs = RANKING_EXAMPLES.flatMap((example) =>
      [example.anchor.card, ...example.candidates.map((c) => c.card)].flatMap((card) =>
        ((card['propertiesSeen'] as Array<{ home: string }>) ?? []).map((entry) => entry.home)),
    );
    expect(refs.some((r) => /^h\d+$/.test(r))).toBe(true);
    expect(refs.some((r) => /^c\d+$/.test(r))).toBe(true);
    expect(refs).toContain('anchor');
  });

  it('is synthetic: no ids, phones or emails on any card; every surname and street is a placeholder word', () => {
    const banned = ['contactId', 'unitId', 'landlordId', 'propertyId', 'phone', 'phones', 'email', 'emails'];
    for (const example of RANKING_EXAMPLES) {
      for (const key of everyKey(example)) expect(banned, example.title).not.toContain(key);
      const cards = [example.anchor.card, ...example.candidates.map((c) => c.card), ...example.homesSeen.map((h) => h.card)];
      for (const card of cards) {
        if (typeof card['lastName'] === 'string') expect(['Example', 'Sample', 'Placeholder']).toContain(card['lastName']);
        const address = card['address'] as { line1?: string } | undefined;
        if (address?.line1 !== undefined) expect(address.line1).toMatch(/Example|Sample|Placeholder/);
      }
      // The stored values off the cards (charter section 20 items 18 and 19) are synthetic too.
      for (const stored of Object.values(example.offCard ?? {})) {
        if (stored['lastName'] !== undefined) expect(['Example', 'Sample', 'Placeholder']).toContain(stored['lastName']);
        const address = stored['address'] as { line1?: string } | undefined;
        if (address?.line1 !== undefined) expect(address.line1).toMatch(/Example|Sample|Placeholder/);
      }
    }
  });

  it('keys the tenant matching inputs by their list labels only', () => {
    const labels = new Set<string>(TENANT_MATCHING_INPUTS.map((e) => e.label));
    for (const example of RANKING_EXAMPLES) {
      for (const key of everyKey(example)) {
        if (/^[A-Z]/.test(key)) expect(labels.has(key), `${example.title}: ${key}`).toBe(true);
      }
    }
  });

  it('is ASCII only', () => {
    expect(JSON.stringify(RANKING_EXAMPLES)).toMatch(/^[\x20-\x7e]*$/);
  });
});
