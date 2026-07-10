// BroadcastComposer tests (§8 item 1) — the composer orchestrator + its single
// throwaway-draft lifecycle. Covers: voucher size pre-fills from ?unitId (mock
// getUnit) + the "matches property" tag; overriding the voucher size; the reach
// count updates from createBroadcast (estimatedCount/truncated) + the truncated
// warning; the single-draft/no-orphan behavior (a material audience change
// recreates the draft and deleteBroadcasts the prior id).
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ContactsPage, EventStreamHandlers, UnitItem } from '../../api/index.js';

const getUnit = vi.fn();
const getContacts = vi.fn();
const createBroadcast = vi.fn();
const deleteBroadcast = vi.fn();
const previewBroadcast = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getUnit: (...a: unknown[]) => getUnit(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    createBroadcast: (...a: unknown[]) => createBroadcast(...a),
    deleteBroadcast: (...a: unknown[]) => deleteBroadcast(...a),
    previewBroadcast: (...a: unknown[]) => previewBroadcast(...a),
    useEventStream: (_h: EventStreamHandlers) => {},
  };
});

import { BroadcastComposer } from './BroadcastComposer.js';

function unit(over: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId: 'unit-0001',
    landlordId: 'contact-landlord-0001',
    status: 'available',
    beds: 2,
    address: { line1: '1450 Joseph E. Boone Blvd NW', city: 'Atlanta', state: 'GA', zip: '30314' },
    ...over,
  };
}

const emptyContacts: ContactsPage = { contacts: [], nextCursor: null };

function renderComposer(search = ''): void {
  render(
    <MemoryRouter initialEntries={[`/broadcasts/new${search}`]}>
      <Routes>
        <Route path="/broadcasts/new" element={<BroadcastComposer />} />
        <Route path="*" element={<div />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getUnit.mockReset().mockResolvedValue(unit());
  getContacts.mockReset().mockResolvedValue(emptyContacts);
  createBroadcast
    .mockReset()
    .mockResolvedValue({ broadcastId: 'draft_1', status: 'draft', estimatedCount: 5, truncated: false });
  deleteBroadcast.mockReset().mockResolvedValue({ deleted: true });
  previewBroadcast.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('BroadcastComposer — voucher size pre-fill from ?unitId', () => {
  it('pre-fills the voucher size from the unit beds + tags the matching chip', async () => {
    renderComposer('?unitId=unit-0001');
    // getUnit fetched the unit (beds 2) → the 2-BR chip is pressed + tagged.
    await waitFor(() => {
      const chip = screen.getByRole('button', { name: /2-BR/ });
      expect(chip).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByText(/matches property/i)).toBeInTheDocument();
    expect(screen.getByText(/Pre-filled to match this 2-bedroom property/i)).toBeInTheDocument();
    expect(getUnit).toHaveBeenCalledWith('unit-0001', expect.anything());
  });

  it('lets the operator override the pre-filled voucher size', async () => {
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByRole('button', { name: /2-BR/ })).toHaveAttribute('aria-pressed', 'true'));
    await u.click(screen.getByRole('button', { name: /^3-BR/ }));
    expect(screen.getByRole('button', { name: /^3-BR/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /2-BR/ })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('BroadcastComposer — reach count + truncated', () => {
  it('shows the reach count from createBroadcast once a message is typed', async () => {
    const u = userEvent.setup();
    renderComposer();
    await u.type(screen.getByLabelText('Message'), 'Hi there');
    // After the debounce, the draft is created and the reach shows.
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Reaches\s*5\s*tenants/));
  });

  it('shows the truncated/capped warning when the estimate is truncated', async () => {
    createBroadcast.mockResolvedValue({ broadcastId: 'draft_1', status: 'draft', estimatedCount: 500, truncated: true });
    const u = userEvent.setup();
    renderComposer();
    await u.type(screen.getByLabelText('Message'), 'Hi there');
    await waitFor(() => expect(screen.getByText(/list is capped/i)).toBeInTheDocument(), { timeout: 4000 });
  });
});

describe('BroadcastComposer — single draft / no orphan', () => {
  it('recreates the draft on a material audience change and deletes the prior draft id', async () => {
    const u = userEvent.setup();
    createBroadcast
      .mockResolvedValueOnce({ broadcastId: 'draft_A', status: 'draft', estimatedCount: 5, truncated: false })
      .mockResolvedValueOnce({ broadcastId: 'draft_B', status: 'draft', estimatedCount: 2, truncated: false });
    renderComposer();
    await u.type(screen.getByLabelText('Message'), 'Hello');
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(1), { timeout: 4000 });

    // A material audience change (pick a voucher size) → a fresh draft, and the
    // PRIOR throwaway (draft_A) is deleted (no orphan).
    await u.click(screen.getByRole('button', { name: '2-BR' }));
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() => expect(deleteBroadcast).toHaveBeenCalledWith('draft_A'));
  });
});

describe('BroadcastComposer — preview gate', () => {
  it('enables Preview only after a draft exists, then advances to the recipient list', async () => {
    previewBroadcast.mockResolvedValue({ count: 1, truncated: false, candidates: [{ contactId: 'c1', firstName: 'Tasha', phone: '+14040000001', alreadySentThisProperty: false, has_consent: true }], priorRecipientContactIds: [] });
    const u = userEvent.setup();
    renderComposer();
    const previewBtn = screen.getByRole('button', { name: 'Preview recipients' });
    // No message yet → disabled, WITH the why-hint (an unexplained disabled
    // button is a dead end for a first-time operator).
    expect(previewBtn).toBeDisabled();
    expect(screen.getByText('Write a message to enable the preview.')).toBeInTheDocument();
    await u.type(screen.getByLabelText('Message'), 'Hello tenants');
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled());
    // Enabled → the hint is gone.
    expect(screen.queryByText('Write a message to enable the preview.')).not.toBeInTheDocument();
    expect(screen.queryByText('Sizing the audience…')).not.toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Preview recipients' }));
    // Advances to the curated list step.
    expect(await screen.findByRole('heading', { name: 'Review recipients' })).toBeInTheDocument();
    expect(previewBroadcast).toHaveBeenCalledWith('draft_1');
  });
});

describe('BroadcastComposer — non-Available property banner (spec 2026-07-10)', () => {
  it('warns when the attached property is not Available (with the human label)', async () => {
    getUnit.mockResolvedValue(unit({ status: 'on_hold' }));
    renderComposer('?unitId=unit-0001');
    // The compose step already renders a role="status" reach element (AudienceFilters),
    // so scope on the banner text and assert on its paragraph (plan Task 3 fallback).
    const note = await screen.findByText(/flyer link won't work/);
    expect(note).toHaveTextContent(/This property is On hold/);
    expect(note).toHaveTextContent(/its flyer link won't work/);
    expect(note).toHaveTextContent(/make it Available when you send/);
  });

  it('no banner for an Available property', async () => {
    getUnit.mockResolvedValue(unit()); // status 'available'
    renderComposer('?unitId=unit-0001');
    // Wait for the unit load to land (the pre-fill tag proves it).
    await screen.findByText(/matches property/i);
    expect(screen.queryByText(/flyer link won't work/)).not.toBeInTheDocument();
  });

  it('no banner when composing without a property', () => {
    renderComposer();
    expect(screen.queryByText(/flyer link won't work/)).not.toBeInTheDocument();
  });
});
