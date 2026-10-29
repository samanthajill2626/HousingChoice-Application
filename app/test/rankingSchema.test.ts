// WP1 B2a spec D5: the ranking structured-output schema. The API compiles a
// schema into a grammar with a size limit no offline test can see (B1: eight
// named objects compiled, twelve failed). This test pins the shape so a later
// edit that grows it fails HERE first (plan WI21); the real compile is
// app/scripts/extraction-schema-compile-check.ts, run by Cameron (PR1).
import { describe, expect, it } from 'vitest';
import { REQUIREMENT_UNIT_KEYS } from '../src/lib/requirements.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import {
  EXCLUDED_REQUIREMENT_KEYS,
  LANDLORD_DEFAULT_KEYS,
  PROPERTY_CARD_FIELDS,
  PROPERTY_FREE_TEXT_FIELDS,
  RANKED_REQUIREMENT_KEYS,
} from '../src/services/ranking/cardFields.js';
import {
  RANKING_SOURCES,
  flagFieldsFor,
  rankingSchema,
  unlawfulFieldsFor,
} from '../src/services/ranking/schema.js';

type Node = Record<string, unknown>;

/** Every JSON-schema keyword that bounds a number, a string or an array. */
const BOUND_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
];

function walk(node: unknown, visit: (obj: Node, path: string) => void, path = 'schema'): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, visit, `${path}[${i}]`));
    return;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Node;
    visit(obj, path);
    for (const [key, value] of Object.entries(obj)) walk(value, visit, `${path}.${key}`);
  }
}

function objectNodes(schema: unknown): Node[] {
  const out: Node[] = [];
  walk(schema, (obj) => {
    if (obj['type'] === 'object') out.push(obj);
  });
  return out;
}

function candidateItem(schema: Node): Node {
  const props = schema['properties'] as Record<string, Node>;
  return (props['candidates']!['items'] as Node);
}

function prop(node: Node, key: string): Node {
  return (node['properties'] as Record<string, Node>)[key]!;
}

describe.each([false, true])('rankingSchema({ landlordCard: %s })', (landlordCard) => {
  const schema = rankingSchema({ landlordCard }) as Node;

  it('has at most five object nodes (root, candidate, two reasons, flag)', () => {
    expect(objectNodes(schema)).toHaveLength(5);
  });

  it('sets additionalProperties:false on every object and requires every key (zero optional parameters)', () => {
    for (const obj of objectNodes(schema)) {
      expect(obj['additionalProperties']).toBe(false);
      const keys = Object.keys(obj['properties'] as Record<string, unknown>);
      expect([...(obj['required'] as string[])].sort()).toEqual([...keys].sort());
    }
  });

  it('carries no numeric or length bounds anywhere', () => {
    walk(schema, (obj, path) => {
      for (const banned of BOUND_KEYWORDS) {
        expect(obj[banned], `${path}.${banned}`).toBeUndefined();
      }
    });
  });

  it('is the spec D5 shape', () => {
    expect(schema['required']).toEqual(['candidates']);
    const item = candidateItem(schema);
    expect(item['required']).toEqual(['candidateId', 'score', 'for', 'against', 'unknowns', 'failedRequirements', 'fairHousingFlags']);
    expect(prop(item, 'candidateId')).toEqual({ type: 'string' });
    expect(prop(item, 'score')).toEqual({ type: 'integer' });
    for (const side of ['for', 'against']) {
      const reason = prop(item, side)['items'] as Node;
      expect(reason['required']).toEqual(['text', 'source']);
      expect(prop(reason, 'text')).toEqual({ type: 'string' });
      expect(prop(reason, 'source')['enum']).toEqual([...RANKING_SOURCES]);
    }
    expect(prop(item, 'unknowns')).toEqual({ type: 'array', items: { type: 'string' } });
    expect((prop(item, 'failedRequirements')['items'] as Node)['enum']).toEqual([...RANKED_REQUIREMENT_KEYS]);
    const flag = prop(item, 'fairHousingFlags')['items'] as Node;
    expect(flag['required']).toEqual(['kind', 'field']);
    expect(prop(flag, 'kind')['enum']).toEqual(['unlawful', 'accommodation']);
    expect(prop(flag, 'field')['enum']).toEqual([...flagFieldsFor(landlordCard)]);
  });

  it('returns the same object on every call (byte-stable request)', () => {
    expect(rankingSchema({ landlordCard })).toBe(schema);
  });
});

describe('the enums', () => {
  it('pins the source enum', () => {
    expect(RANKING_SOURCES).toEqual([
      'voucher_size', 'authority', 'rent', 'area', 'pets', 'evictions', 'accessibility', 'requirements',
      'preferences', 'notes', 'staff_notes', 'feedback', 'history', 'recency', 'property_details', 'other',
    ]);
  });

  it('the requirement keys are REQUIREMENT_UNIT_KEYS less credit and income (never reported failed)', () => {
    expect(EXCLUDED_REQUIREMENT_KEYS).toEqual(['credit_requirements', 'income_requirements']);
    expect(RANKED_REQUIREMENT_KEYS).toEqual(REQUIREMENT_UNIT_KEYS.filter((k) => k !== 'credit_requirements' && k !== 'income_requirements'));
    expect(RANKED_REQUIREMENT_KEYS).toHaveLength(13);
  });

  it('pins the eleven free-text fields an unlawful flag may name (spec D5)', () => {
    expect(PROPERTY_FREE_TEXT_FIELDS).toEqual([
      'notes', 'lease_terms', 'application_process', 'qualifications', 'evictions_notes', 'pets',
      'pet_fee', 'deposit_notes', 'tour_process', 'utilities', 'accessibility',
    ]);
  });

  it('switch off: the requirement keys then the free-text fields that are not requirement keys (18)', () => {
    expect(flagFieldsFor(false)).toEqual([...RANKED_REQUIREMENT_KEYS, 'notes', 'lease_terms', 'application_process', 'utilities', 'accessibility']);
    expect(flagFieldsFor(false)).toHaveLength(18);
    for (const checkbox of ['no_pets', 'no_evictions_on_program', 'deposit_one_month', 'deposit_flexible']) {
      expect(flagFieldsFor(false)).toContain(checkbox);
    }
  });

  it('switch on: adds landlord:<key> for every landlord default (13 keys + notes = 14)', () => {
    expect(LANDLORD_DEFAULT_KEYS).toEqual([...RANKED_REQUIREMENT_KEYS, 'notes']);
    expect(flagFieldsFor(true)).toEqual([...flagFieldsFor(false), ...LANDLORD_DEFAULT_KEYS.map((f) => `landlord:${f}`)]);
    expect(flagFieldsFor(true)).toHaveLength(32);
    expect(flagFieldsFor(true)).not.toContain('landlord:lease_terms');
    expect(flagFieldsFor(true)).not.toContain('landlord:credit_requirements');
  });

  it('an unlawful flag may name only a free-text field (and its landlord twin when on)', () => {
    expect(unlawfulFieldsFor(false)).toEqual([...PROPERTY_FREE_TEXT_FIELDS]);
    expect(unlawfulFieldsFor(true)).toEqual([
      ...PROPERTY_FREE_TEXT_FIELDS,
      'landlord:evictions_notes', 'landlord:qualifications', 'landlord:pets', 'landlord:pet_fee',
      'landlord:deposit_notes', 'landlord:tour_process', 'landlord:notes',
    ]);
    for (const checkbox of ['no_pets', 'no_evictions_on_program', 'deposit_one_month', 'deposit_flexible', 'deposit', 'application_fee', 'tour_type']) {
      expect(unlawfulFieldsFor(true)).not.toContain(checkbox);
    }
  });
});

// PR33 / WI22: the field constants live in cardFields.ts (S3); the schema
// derives its enums from them. Tie them to the card: every free-text field
// and every reportable requirement key is an INCLUDED property-card field, and
// every free-text field but the legacy `pets` (read through unitItemValue,
// plan C2) is string-typed on UnitItem - the `satisfies` below fails
// `npm run typecheck` (vitest strips types) if one changes type.
type FreeTextField = 'notes' | 'lease_terms' | 'application_process' | 'qualifications' | 'evictions_notes'
  | 'pet_fee' | 'deposit_notes' | 'tour_process' | 'utilities' | 'accessibility';
const STRING_TYPED_FREE_TEXT = {
  notes: true, lease_terms: true, application_process: true, qualifications: true, evictions_notes: true,
  pet_fee: true, deposit_notes: true, tour_process: true, utilities: true, accessibility: true,
} as const satisfies { [K in FreeTextField]: UnitItem[K] extends string | undefined ? true : never };

describe('the card-field constants are the card\'s (PR33)', () => {
  it('every free-text field and every reportable requirement key is an included property-card field', () => {
    const registry = PROPERTY_CARD_FIELDS as Readonly<Record<string, { use: string }>>;
    for (const field of [...PROPERTY_FREE_TEXT_FIELDS, ...RANKED_REQUIREMENT_KEYS]) {
      expect(registry[field]?.use, field).toBe('include');
    }
  });

  it('the free-text list is the string-typed set plus the legacy pets (WI22)', () => {
    expect([...PROPERTY_FREE_TEXT_FIELDS].sort()).toEqual([...Object.keys(STRING_TYPED_FREE_TEXT), 'pets'].sort());
  });
});
