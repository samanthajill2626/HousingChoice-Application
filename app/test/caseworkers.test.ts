// The caseworker matching rules (spec
// docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md
// D16, D22 "Matching"; plan 3.2; planner ruling R1-F8). Three tiers: the
// kind canonicalizer is byte-exact (contactKinds.test.ts); the Caseworkers
// tab uses isCaseworkerRole (the D4 form IS "caseworker" or "case worker");
// the Possible list, the relationship signal and the KindPicker datalist use
// mentionsCaseworker (the D4 form CONTAINS "caseworker", "case worker" or
// "case manager"). The AI-note signal reads only a line carrying the
// extraction's own "[Auto - <date>]" prefix.
import { describe, expect, it } from 'vitest';
import {
  CASEWORKER_ROLE,
  hasAiCaseworkerNote,
  isCaseworker,
  isCaseworkerRole,
  mentionsCaseworker,
  type PossibleSignal,
} from '../src/lib/caseworkers.js';
import { CASEWORKER_ROLE as KINDS_CASEWORKER_ROLE } from '../src/services/extraction/contactKinds.js';
import { buildExtractionSystemPrompt } from '../src/services/extraction/prompt.js';

/** A Unicode hyphen built at run time, so this file stays ASCII (U+2010). */
const UNICODE_HYPHEN = String.fromCharCode(0x2010);

/**
 * The AI's own line, read VERBATIM from the extraction prompt's Partner
 * example (services/extraction/prompt.ts, the "I am her caseworker at Hope
 * Atlanta" line) - so a prompt edit that changes the taught wording fails
 * here instead of silently emptying the AI-note signal.
 */
const PROMPT_NOTE = /add "(Identified as a caseworker[^"]*)"/.exec(buildExtractionSystemPrompt())?.[1];

describe('the caseworker preset', () => {
  it('is defined here and re-exported by contactKinds (one constant, D16)', () => {
    expect(CASEWORKER_ROLE).toBe(KINDS_CASEWORKER_ROLE);
    expect(CASEWORKER_ROLE).toBe('Caseworker');
  });
  it('satisfies the tab rule and the mentions rule', () => {
    expect(isCaseworkerRole(CASEWORKER_ROLE)).toBe(true);
    expect(mentionsCaseworker(CASEWORKER_ROLE)).toBe(true);
  });
});

describe('isCaseworkerRole (the Caseworkers tab, D16)', () => {
  it.each([
    'Caseworker',
    'caseworker',
    '  CASEWORKER  ',
    'Case worker',
    'case-worker',
    'Case  Worker.',
    'Case_Worker',
    `Case${UNICODE_HYPHEN}worker`,
  ])('accepts %o', (role) => {
    expect(isCaseworkerRole(role)).toBe(true);
  });
  it.each([
    'Caseworkers',
    'Senior Caseworker',
    'Caseworker - DFCS',
    'Case worker 2',
    'Case Manager',
    'Case wor ker',
    'Property Manager',
    '',
    '   ',
    undefined,
    null,
    7,
  ])('refuses %o', (role) => {
    expect(isCaseworkerRole(role)).toBe(false);
  });
});

describe('mentionsCaseworker (the Possible list and the datalist filter, D22)', () => {
  it.each([
    'Caseworker',
    'Caseworkers',
    'Senior Caseworker',
    'Caseworker - DFCS',
    'Case worker 2',
    'Case-Worker',
    'Case Manager',
    'case-manager',
    'Housing Case Manager',
    'CASE  MANAGER',
  ])('accepts %o', (role) => {
    expect(mentionsCaseworker(role)).toBe(true);
  });
  it.each([
    'Case Mgr',
    'Case management',
    'Casework',
    'Social worker',
    'Property Manager',
    'Manager of cases',
    '',
    undefined,
    null,
    3,
  ])('refuses %o', (role) => {
    expect(mentionsCaseworker(role)).toBe(false);
  });
});

describe('hasAiCaseworkerNote (the AI-note signal, D22)', () => {
  it('reads the prompt line verbatim (prompt.ts Partner example)', () => {
    expect(PROMPT_NOTE).toBe('Identified as a caseworker at Hope Atlanta');
    expect(hasAiCaseworkerNote(`[Auto - Oct 7] ${PROMPT_NOTE}`)).toBe(true);
  });
  it.each([
    'Prefers texts\n[Auto - Jul 16] Identified as caseworker for DFCS',
    '[Auto - Jan 2] identified as a case worker at Step Up',
    '[Auto - Jan 2] IDENTIFIED AS CASE WORKER',
    '[Auto - Jan 2]Identified as a caseworker',
    'Line one\r\n[Auto - Jan 2] Identified as a caseworker at Hope Atlanta\r\nLine three',
  ])('accepts a prefixed line in %o', (notes) => {
    expect(hasAiCaseworkerNote(notes)).toBe(true);
  });
  it.each([
    // No prefix: staff-typed words are not the AI's line (R1-F8).
    'Identified as a caseworker at Hope Atlanta',
    'Staff: Identified as a caseworker',
    '[Auto] Identified as a caseworker',
    // The tenant's OWN caseworker is mentioned, not identified (prompt.ts).
    '[Auto - Oct 7] Said her caseworker at Hope Atlanta will call',
    '[Auto - Oct 7] Identified as a property manager',
    '[Auto - Oct 7] Identified as a case manager',
    '[Auto - Oct 7] Identified as the caseworker',
    '',
    undefined,
    null,
    5,
  ])('refuses %o', (notes) => {
    expect(hasAiCaseworkerNote(notes)).toBe(false);
  });
});

describe('isCaseworker (a partner whose role satisfies isCaseworkerRole)', () => {
  it.each([
    [{ type: 'partner', role: 'Caseworker' }, true],
    [{ type: 'partner', role: 'case worker' }, true],
    [{ type: 'partner', role: 'Case Manager' }, false],
    [{ type: 'partner' }, false],
    [{ type: 'tenant', role: 'Caseworker' }, false],
    [{ type: 'landlord', role: 'Caseworker' }, false],
    [{ type: 'unknown', role: 'Caseworker' }, false],
    [{ type: 'team_member', role: 'Caseworker' }, false],
  ] as const)('%o -> %s', (contact, expected) => {
    expect(isCaseworker(contact)).toBe(expected);
  });
});

describe('PossibleSignal (plan 3.2 wire names)', () => {
  it('names the four signals in declaration order', () => {
    const order: PossibleSignal[] = ['role_mentions', 'ai_note', 'relationship', 'partner_no_role'];
    expect(order).toHaveLength(4);
  });
});
