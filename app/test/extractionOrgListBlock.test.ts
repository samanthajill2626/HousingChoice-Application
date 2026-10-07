// Spec 2026-10-06 D8: the ORGANIZATION LIST block of the extraction USER
// content - its shape, the one-line and TRANSCRIPT rules, the 16,000-character
// budget with its drop order, and the fingerprint the run log records.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OrgEntry } from '../src/lib/orgNames.js';
import { buildStartingEntries } from '../src/lib/orgStartingList.js';
import {
  ORG_LIST_BLOCK_BUDGET,
  ORG_LIST_BLOCK_HEADER,
  renderOrgListBlock,
} from '../src/services/extraction/orgListBlock.js';

const NOW = '2026-10-06T00:00:00.000Z';

function org(kind: OrgEntry['kind'], name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId: `id-${name}`,
    kind,
    name,
    spellings,
    createdAt: NOW,
    createdBy: 'test',
    updatedAt: NOW,
    updatedBy: 'test',
  };
}

const ALPHA = org('housing_authority', 'Alpha Housing Authority', ['AHA', 'Alpha HA']);
const BETA = org('housing_authority', 'Beta Housing Authority', ['BHA']);
const GAMMA = org('agency', 'Gamma Services', ['Gamma Svc Co']);
/** Stored order deliberately NOT name order. */
const LIST = [GAMMA, BETA, ALPHA];

describe('renderOrgListBlock - shape', () => {
  it('starts with the header, lists housing authorities with spellings, then agency names under "not housing authorities"', () => {
    const { text, dropped, unrenderable } = renderOrgListBlock(LIST);
    const lines = text.split('\n');
    expect(ORG_LIST_BLOCK_HEADER).toBe('ORGANIZATION LIST');
    expect(lines[0]).toBe(ORG_LIST_BLOCK_HEADER);
    const alpha = lines.indexOf('- Alpha Housing Authority | also: AHA | Alpha HA');
    const beta = lines.indexOf('- Beta Housing Authority | also: BHA');
    const agencyHeading = lines.findIndex((line) => line.includes('not housing authorities'));
    const gamma = lines.indexOf('- Gamma Services');
    expect(alpha).toBeGreaterThan(0);
    expect(beta).toBeGreaterThan(alpha);
    expect(agencyHeading).toBeGreaterThan(beta);
    expect(gamma).toBeGreaterThan(agencyHeading);
    // Agencies are listed by NAME only (apply.ts still resolves their spellings).
    expect(text).not.toContain('Gamma Svc Co');
    expect(dropped).toEqual({ spellings: 0, agencies: 0, authorities: 0 });
    expect(unrenderable).toEqual({ spellings: 0, agencies: 0, authorities: 0 });
  });

  it('orders entries by name, so the stored order changes neither the text nor the fingerprint', () => {
    const a = renderOrgListBlock(LIST);
    const b = renderOrgListBlock([...LIST].reverse());
    expect(b.text).toBe(a.text);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it('fingerprint is the sha256 hex of the text and changes with the list', () => {
    const block = renderOrgListBlock(LIST);
    expect(block.fingerprint).toBe(createHash('sha256').update(block.text, 'utf8').digest('hex'));
    expect(block.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const fewerSpellings = renderOrgListBlock([
      GAMMA,
      BETA,
      org('housing_authority', 'Alpha Housing Authority', ['AHA']),
    ]);
    expect(fewerSpellings.fingerprint).not.toBe(block.fingerprint);
  });

  it('renders every name and spelling on ONE line - control characters become spaces', () => {
    const { text } = renderOrgListBlock([
      org('housing_authority', 'Line\nBreak Housing Authority', ['LB\r\nHA']),
      org('agency', 'Tab\tAgency'),
    ]);
    const lines = text.split('\n');
    expect(lines).toContain('- Line Break Housing Authority | also: LB HA');
    expect(lines).toContain('- Tab Agency');
    expect(lines).toHaveLength(5);
  });

  it('never contains the word TRANSCRIPT: a name or spelling holding it is left out and counted as unrenderable, not as a budget drop', () => {
    const block = renderOrgListBlock([
      ALPHA,
      org('housing_authority', 'Transcript Housing Authority', ['THA']),
      org('housing_authority', 'Beta Housing Authority', ['BHA', 'beta transcript office']),
      org('agency', 'TRANSCRIPT Services'),
    ]);
    expect(block.text).not.toMatch(/transcript/i);
    const lines = block.text.split('\n');
    // A left-out name costs nothing else - only the BUDGET cascades.
    expect(lines).toContain('- Alpha Housing Authority | also: AHA | Alpha HA');
    expect(lines).toContain('- Beta Housing Authority | also: BHA');
    // THA goes with its unrenderable name; 'beta transcript office' on its own.
    expect(block.unrenderable).toEqual({ spellings: 2, agencies: 1, authorities: 1 });
    // More budget would not bring any of them back: no budget drop (spec D8 WARNs only on those).
    expect(block.dropped).toEqual({ spellings: 0, agencies: 0, authorities: 0 });
  });

  it('renders the whole starting list inside the default budget with nothing dropped', () => {
    let n = 0;
    const entries = buildStartingEntries(NOW, () => `org-${(n += 1)}`);
    const block = renderOrgListBlock(entries);
    expect(ORG_LIST_BLOCK_BUDGET).toBe(16_000);
    expect(block.dropped).toEqual({ spellings: 0, agencies: 0, authorities: 0 });
    expect(block.unrenderable).toEqual({ spellings: 0, agencies: 0, authorities: 0 });
    expect(block.text.length).toBeLessThanOrEqual(ORG_LIST_BLOCK_BUDGET);
    for (const entry of entries) expect(block.text).toContain(`- ${entry.name}`);
    expect(block.text).toContain('Housing Authority of the City of Atlanta');
    // An agency spelling (HOPE Atlanta's) is not rendered.
    expect(block.text).not.toContain('Travelers Aid');
  });
});

describe('renderOrgListBlock - the budget (spec D8 drop order)', () => {
  const full = renderOrgListBlock(LIST).text.length;
  // What each part of LIST's full text costs, line breaks included.
  const SPELLINGS = ' | also: AHA | Alpha HA'.length + ' | also: BHA'.length;
  const GAMMA_LINE = '\n- Gamma Services'.length;

  it('keeps the text within the budget', () => {
    for (const budget of [full, full - 1, full - SPELLINGS, full - SPELLINGS - 1, full - SPELLINGS - GAMMA_LINE - 1]) {
      expect(renderOrgListBlock(LIST, { budget }).text.length).toBeLessThanOrEqual(budget);
    }
  });

  it('drops spellings first - only the ones that do not fit', () => {
    const block = renderOrgListBlock(LIST, { budget: full - 1 });
    expect(block.dropped).toEqual({ spellings: 1, agencies: 0, authorities: 0 });
    expect(block.unrenderable).toEqual({ spellings: 0, agencies: 0, authorities: 0 });
    const lines = block.text.split('\n');
    expect(lines).toContain('- Alpha Housing Authority | also: AHA | Alpha HA');
    expect(lines).toContain('- Beta Housing Authority');
    expect(lines).toContain('- Gamma Services');
  });

  it('drops every spelling before any name', () => {
    const block = renderOrgListBlock(LIST, { budget: full - SPELLINGS });
    expect(block.dropped).toEqual({ spellings: 3, agencies: 0, authorities: 0 });
    expect(block.text).not.toContain(' | also: ');
    expect(block.text.split('\n')).toContain('- Gamma Services');
  });

  it('then agency names, keeping every housing authority name', () => {
    const block = renderOrgListBlock(LIST, { budget: full - SPELLINGS - 1 });
    expect(block.dropped).toEqual({ spellings: 3, agencies: 1, authorities: 0 });
    const lines = block.text.split('\n');
    expect(lines).toContain('- Alpha Housing Authority');
    expect(lines).toContain('- Beta Housing Authority');
    expect(block.text).not.toContain('Gamma');
  });

  it('then the housing authority names that do not fit - and nothing of a lower class after one', () => {
    // Room for Alpha's line but not Beta's. Gamma's shorter line would still
    // fit, but an agency name never outranks a housing authority name.
    const block = renderOrgListBlock(LIST, { budget: full - SPELLINGS - GAMMA_LINE - 1 });
    expect(block.dropped).toEqual({ spellings: 3, agencies: 1, authorities: 1 });
    expect(block.text.split('\n')).toContain('- Alpha Housing Authority');
    expect(block.text).not.toContain('Beta');
    expect(block.text).not.toContain('Gamma');
  });
});
