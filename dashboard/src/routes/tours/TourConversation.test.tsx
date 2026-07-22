// TourConversation tests - the manual "Send no-show check-in" seed threading
// (Plan Task 4 / slice S4). Verifies the two invariants that make the seed safe:
//   1) TENANT ONLY: a noShowDraft nonce bump selects the Tenant tab and prefills
//      the tenant 1:1 composer (never the landlord/PM pane).
//   2) ONE-SHOT: the seed is consumed on mount, so a later MANUAL return to the
//      Tenant tab starts with an EMPTY composer (no persistent re-seed).
//
// TourConversation is rendered DIRECTLY with a hand-built `channels` stub (the
// real useTourChannels is covered by its own suite + TourDetail.test). Both 1:1
// channels resolve to a null conversationId -> the synchronous NewContactThread
// path (no useRelayThread, no network), and the group channel is left unresolved
// so the initial Group pane is the empty state - so the whole tree renders with
// no api mock at all.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { TourConversation, type TourConversationProps } from './TourConversation.js';
import type { Contact, Tour } from '../../api/index.js';
import type { TourChannelsState } from './useTourChannels.js';

const SEED = 'Hi! We noticed you may have missed your tour. Want to reschedule?';

function makeTour(over: Partial<Tour> = {}): Tour {
  return {
    tourId: 'tour-abc',
    tenantId: 'tenant-1',
    unitId: 'unit-1',
    scheduledAt: '2026-07-10T14:00:00Z',
    tourType: 'self_guided',
    status: 'scheduled',
    createdAt: '2026-07-01T10:00:00Z',
    groupThreadId: 'g1',
    ...over,
  };
}

function tenantContact(): Contact {
  return {
    contactId: 'tenant-1',
    type: 'tenant',
    status: 'searching',
    firstName: 'Ann',
    lastName: 'Tenant',
    voucherSize: 2,
    phone: '+14045550111',
  };
}

function landlordContact(): Contact {
  return {
    contactId: 'landlord-1',
    type: 'landlord',
    firstName: 'Lon',
    lastName: 'Landlord',
    phone: '+14045550222',
  };
}

// Both 1:1 channels unresolved (null id -> NewContactThread), and the group
// unresolved so the initial Group pane is the empty state (fully synchronous).
function makeChannels(): TourChannelsState {
  return {
    status: 'ready',
    group: { conversationId: null, unread: 0 },
    tenant: { conversationId: null, unread: 0 },
    landlord: { conversationId: null, unread: 0 },
    setConversationId: vi.fn(),
    markRead: vi.fn(),
  };
}

function baseProps(over: Partial<TourConversationProps> = {}): TourConversationProps {
  return {
    tour: makeTour(),
    tenant: tenantContact(),
    landlord: landlordContact(),
    landlordId: 'landlord-1',
    channels: makeChannels(),
    onOpenGroup: vi.fn(),
    openGroupBusy: false,
    ...over,
  };
}

function renderConvo(props: TourConversationProps, draft?: TourConversationProps['noShowDraft']) {
  return render(
    <MemoryRouter>
      <TourConversation {...props} {...(draft !== undefined && { noShowDraft: draft })} />
    </MemoryRouter>,
  );
}

describe('TourConversation - no-show check-in seed', () => {
  it('switches to the tenant tab and seeds the composer when noShowDraft nonce bumps', async () => {
    const props = baseProps();
    const { rerender } = renderConvo(props);

    // Starts on the Group tab (the tour has a groupThreadId); no tenant composer
    // is mounted yet, so nothing is seeded.
    expect(screen.getByRole('tab', { name: 'Group text' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).not.toBeInTheDocument();

    // A "Send no-show check-in" click bumps the nonce.
    rerender(
      <MemoryRouter>
        <TourConversation {...props} noShowDraft={{ body: SEED, nonce: 1 }} />
      </MemoryRouter>,
    );

    // The Tenant tab becomes selected and its composer shows the seeded copy.
    expect(
      await screen.findByRole('tab', { name: /Tenant/, selected: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue(SEED);
  });

  it('never seeds the landlord pane, and a later return to Tenant starts EMPTY', async () => {
    const props = baseProps();
    const { rerender } = renderConvo(props);
    rerender(
      <MemoryRouter>
        <TourConversation {...props} noShowDraft={{ body: SEED, nonce: 1 }} />
      </MemoryRouter>,
    );
    // Seeded once on the tenant pane.
    expect(await screen.findByRole('textbox', { name: 'Reply message' })).toHaveValue(SEED);

    // Invariant 1: switching to the Landlord pane shows an EMPTY composer - the
    // seed never reaches the landlord/PM 1:1.
    await userEvent.click(screen.getByRole('tab', { name: /Landlord/ }));
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('');

    // Invariant 2: a later MANUAL return to the Tenant tab remounts a fresh pane
    // with no seed (the one-shot seed was consumed, not persisted).
    await userEvent.click(screen.getByRole('tab', { name: /Tenant/ }));
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toHaveValue('');
  });
});
