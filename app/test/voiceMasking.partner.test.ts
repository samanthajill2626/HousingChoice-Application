// A2 (email-channel-v1): the 'partner' ContactType end-to-end. voiceMasking is
// the shared honesty-rule source of truth for the voice bridges; a partner
// contact must map to a partner_1to1 thread and author its messages as
// 'partner' (author-honesty rule), exactly as tenant/landlord do.
import { describe, expect, it } from 'vitest';
import { authorForContact, conversationTypeFor } from '../src/lib/voiceMasking.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';

const partner = { contactId: 'c-partner', type: 'partner' } as ContactItem;

describe('voiceMasking — partner honesty mapping (A2)', () => {
  it('conversationTypeFor(partner) -> partner_1to1', () => {
    expect(conversationTypeFor(partner)).toBe('partner_1to1');
  });

  it('authorForContact(partner) -> partner', () => {
    expect(authorForContact(partner)).toBe('partner');
  });

  it('leaves tenant/landlord/unknown mappings unchanged', () => {
    expect(conversationTypeFor({ type: 'tenant' } as ContactItem)).toBe('tenant_1to1');
    expect(conversationTypeFor({ type: 'landlord' } as ContactItem)).toBe('landlord_1to1');
    expect(conversationTypeFor(undefined)).toBe('unknown_1to1');
    expect(authorForContact({ type: 'tenant' } as ContactItem)).toBe('tenant');
    expect(authorForContact({ type: 'team_member' } as ContactItem)).toBe('unknown');
  });
});
