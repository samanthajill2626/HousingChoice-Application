// TenantFile - the staff-notes slice (spec 3.6): "Staff notes" renders
// directly ABOVE "Preferences & notes" for a TENANT, not at all for a
// team_member (TenantFile serves both kinds), and the existing card keeps its
// copy and its "+ Add" affordance untouched.
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Contact } from '../../api/index.js';
import { TenantFile } from './TenantFile.js';

// The media gallery and the group cards fetch nothing when handed empty
// arrays; the Eligibility intake card reads only the contact.
const CONTACT: Contact = {
  contactId: 'c1',
  type: 'tenant',
  status: 'searching',
  firstName: 'Tasha',
  lastName: 'Nguyen',
  phone: '+14045550111',
  staff_notes: 'Has a service dog',
  staff_notes_updated_at: '2026-09-26T15:00:00.000Z',
};

function renderFile(over: Partial<Contact> = {}): void {
  render(
    <MemoryRouter>
      <TenantFile
        contact={{ ...CONTACT, ...over }}
        phones={[{ phone: '+14045550111', primary: true }]}
        placements={[]}
        tours={[]}
        units={[]}
        listingsSentPending={false}
        listingsSent={[]}
        relayGroupsPending={false}
        relayGroups={[]}
        groupThreadsPending={false}
        groupThreads={[]}
        groupThreadsTruncated={false}
        media={[]}
        onEdit={vi.fn()}
        onContactUpdated={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('TenantFile - Staff notes card placement', () => {
  it('renders Staff notes directly above Preferences & notes for a tenant, both with their own affordances', () => {
    renderFile();
    const staff = screen.getByRole('heading', { name: /Staff notes/ });
    const prefs = screen.getByRole('heading', { name: /Preferences & notes/ });
    // Document order: the staff card precedes the preferences card.
    expect(staff.compareDocumentPosition(prefs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Has a service dog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit staff notes' })).toBeInTheDocument();
    // The existing card is untouched: its "+ Add" still opens the edit dialog.
    expect(screen.getByRole('button', { name: 'Add a note' })).toBeInTheDocument();
    expect(screen.getByText(/No preferences yet/)).toBeInTheDocument();
  });

  it('renders NO Staff notes card for a team_member (TenantFile serves that kind too)', () => {
    renderFile({ type: 'team_member', status: 'active' });
    expect(screen.queryByRole('heading', { name: /Staff notes/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Has a service dog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Preferences & notes/ })).toBeInTheDocument();
  });
});
