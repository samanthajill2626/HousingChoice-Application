import { describe, expect, it } from 'vitest';
import {
  conversationTypeLabel,
  contactFullName,
  formatPhone,
  isContactNeedsReview,
  resolveIdentity,
} from './identity';
import type { Contact, Conversation } from '../../api';

function conv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    conversationId: 'c1',
    participant_phone: '+13135551234',
    status: 'open',
    last_activity_at: '2026-06-12T00:00:00Z',
    type: 'unknown_1to1',
    ai_mode: 'auto',
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return { contactId: 'k1', type: 'unknown', ...overrides };
}

describe('formatPhone', () => {
  it('formats a +1 E.164 number as (AAA) BBB-CCCC', () => {
    expect(formatPhone('+13135551234')).toBe('(313) 555-1234');
  });
  it('formats a bare 10-digit number', () => {
    expect(formatPhone('3135551234')).toBe('(313) 555-1234');
  });
  it('returns unexpected shapes unchanged', () => {
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
  });
  it('handles a missing phone', () => {
    expect(formatPhone(undefined)).toBe('Unknown number');
  });
});

describe('contactFullName', () => {
  it('joins first + last', () => {
    expect(contactFullName(contact({ firstName: 'Keisha', lastName: 'Jones' }))).toBe('Keisha Jones');
  });
  it('is undefined when neither is set', () => {
    expect(contactFullName(contact())).toBeUndefined();
  });
});

describe('isContactNeedsReview', () => {
  it('is true for an unknown type', () => {
    expect(isContactNeedsReview(contact({ type: 'unknown' }))).toBe(true);
  });
  it('is true for a needs_review status', () => {
    expect(isContactNeedsReview(contact({ type: 'tenant', status: 'needs_review' }))).toBe(true);
  });
  it('is false for a resolved tenant', () => {
    expect(isContactNeedsReview(contact({ type: 'tenant', status: 'active' }))).toBe(false);
  });
});

describe('resolveIdentity', () => {
  it('shows "needs review" + the phone for an unknown_1to1 thread (never a fake name)', () => {
    const id = resolveIdentity(conv({ type: 'unknown_1to1' }), contact({ firstName: 'Keisha', type: 'unknown' }));
    expect(id.needsReview).toBe(true);
    expect(id.label).toBe('(313) 555-1234');
    expect(id.name).toBeUndefined();
  });

  it('shows the real name once the thread is triaged', () => {
    const id = resolveIdentity(
      conv({ type: 'tenant_1to1' }),
      contact({ firstName: 'Keisha', lastName: 'Jones', type: 'tenant', status: 'active' }),
    );
    expect(id.needsReview).toBe(false);
    expect(id.label).toBe('Keisha Jones');
    expect(id.name).toBe('Keisha Jones');
  });

  it('resolves a triaged team_member contact (name + no review) even when the thread stays unknown_1to1', () => {
    // Regression (the operator hit this): a contact triaged to a NON-tenant/
    // landlord type (pm/team_member) has no *_1to1 thread value, so the
    // conversation stays unknown_1to1. Resolution must follow the CONTACT —
    // an active team_member with a name is resolved: no "?"/review cue, real name.
    const id = resolveIdentity(
      conv({ type: 'unknown_1to1' }),
      contact({ firstName: 'Jamie', lastName: 'Rivera', type: 'team_member', status: 'active' }),
    );
    expect(id.needsReview).toBe(false);
    expect(id.label).toBe('Jamie Rivera');
    expect(id.name).toBe('Jamie Rivera');
  });
});

describe('conversationTypeLabel', () => {
  it('maps the resolved types', () => {
    expect(conversationTypeLabel('tenant_1to1')).toBe('Tenant');
    expect(conversationTypeLabel('landlord_1to1')).toBe('Landlord');
  });
  it('falls back to Needs review for unknown', () => {
    expect(conversationTypeLabel('unknown_1to1')).toBe('Needs review');
    expect(conversationTypeLabel(undefined)).toBe('Needs review');
  });
});
