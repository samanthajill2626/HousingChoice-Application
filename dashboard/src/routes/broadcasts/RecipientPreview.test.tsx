// RecipientPreview tests (§8) — the editable curated recipient list. Covers:
// every candidate rendered individually with a checkbox; already-sent rows
// unchecked + amber-flagged; Select-all SKIPS already-sent; Deselect-all clears;
// search-within filters; add-a-tenant appends (annotated via
// priorRecipientContactIds); remove/uncheck; Send posts the EXACT checked
// recipientContactIds; 400 empty_audience / over-cap / 409 inline (409 offers a
// Results link); Delete draft (409 → Results).
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/index.js';
import type { Contact, PreviewResponse } from '../../api/index.js';

const sendBroadcast = vi.fn();
const deleteBroadcast = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    sendBroadcast: (...a: unknown[]) => sendBroadcast(...a),
    deleteBroadcast: (...a: unknown[]) => deleteBroadcast(...a),
  };
});

import { RecipientPreview } from './RecipientPreview.js';

function candidate(over: Partial<PreviewResponse['candidates'][number]> = {}): PreviewResponse['candidates'][number] {
  return {
    contactId: 'c1',
    firstName: 'Tasha',
    phone: '+14040000001',
    voucherSize: 2,
    alreadySentThisProperty: false,
    ...over,
  };
}

function previewOf(over: Partial<PreviewResponse> = {}): PreviewResponse {
  return {
    count: 0,
    truncated: false,
    candidates: [],
    priorRecipientContactIds: [],
    ...over,
  };
}

function tenant(over: Partial<Contact> = {}): Contact {
  return {
    contactId: 'cX',
    type: 'tenant',
    firstName: 'New',
    lastName: 'Tenant',
    phone: '+14040000099',
    ...over,
  };
}

/** Surfaces the current pathname so navigation (Send/Delete → Results/list) is assertable. */
function LocationProbe(): React.JSX.Element {
  const loc = useLocation();
  return <span data-testid="path">{loc.pathname}</span>;
}

function renderPreview(props: {
  preview: PreviewResponse;
  tenantCandidates?: Contact[];
  candidatesLoading?: boolean;
  draftId?: string;
}): void {
  render(
    <MemoryRouter initialEntries={['/broadcasts/new']}>
      <Routes>
        <Route
          path="/broadcasts/new"
          element={
            <RecipientPreview
              draftId={props.draftId ?? 'bcast_1'}
              preview={props.preview}
              tenantCandidates={props.tenantCandidates ?? []}
              candidatesLoading={props.candidatesLoading ?? false}
            />
          }
        />
        <Route path="*" element={<div />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sendBroadcast.mockReset().mockResolvedValue({ broadcastId: 'bcast_1', status: 'sending', count: 1 });
  deleteBroadcast.mockReset().mockResolvedValue({ deleted: true });
});
afterEach(() => vi.restoreAllMocks());

describe('RecipientPreview — list rendering', () => {
  it('lists EVERY candidate individually with a checkbox', () => {
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha' }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002' }),
          candidate({ contactId: 'c3', firstName: 'Cy', phone: '+14040000003' }),
        ],
      }),
    });
    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    const checkboxes = within(list).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);
    expect(within(list).getByText('Tasha')).toBeInTheDocument();
    expect(within(list).getByText('Bo')).toBeInTheDocument();
    expect(within(list).getByText('Cy')).toBeInTheDocument();
    // All checked (none already-sent).
    checkboxes.forEach((cb) => expect(cb).toBeChecked());
  });

  it('renders already-sent rows UNCHECKED + flagged "Already sent"', () => {
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha' }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002', alreadySentThisProperty: true }),
        ],
        priorRecipientContactIds: ['c2'],
      }),
    });
    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    expect(within(list).getByText('Already sent')).toBeInTheDocument();
    // Bo (already sent) starts unchecked; Tasha checked.
    const bo = within(list).getByText('Bo').closest('li') as HTMLElement;
    const tasha = within(list).getByText('Tasha').closest('li') as HTMLElement;
    expect(within(bo).getByRole('checkbox')).not.toBeChecked();
    expect(within(tasha).getByRole('checkbox')).toBeChecked();
  });
});

describe('RecipientPreview — bulk select', () => {
  it('Select all SKIPS already-sent rows; Deselect all clears everyone', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha' }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002', alreadySentThisProperty: true }),
        ],
        priorRecipientContactIds: ['c2'],
      }),
    });
    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    const bo = within(list).getByText('Bo').closest('li') as HTMLElement;
    const tasha = within(list).getByText('Tasha').closest('li') as HTMLElement;

    await u.click(screen.getByRole('button', { name: 'Select all' }));
    // Tasha checked, Bo (already sent) stays unchecked.
    expect(within(tasha).getByRole('checkbox')).toBeChecked();
    expect(within(bo).getByRole('checkbox')).not.toBeChecked();

    await u.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(within(tasha).getByRole('checkbox')).not.toBeChecked();
    expect(within(bo).getByRole('checkbox')).not.toBeChecked();
  });
});

describe('RecipientPreview — search-within', () => {
  it('filters the visible rows by name/phone', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha' }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002' }),
        ],
      }),
    });
    await u.type(screen.getByPlaceholderText(/Search recipients/i), 'Tash');
    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    expect(within(list).getByText('Tasha')).toBeInTheDocument();
    expect(within(list).queryByText('Bo')).not.toBeInTheDocument();
  });
});

describe('RecipientPreview — add a tenant', () => {
  it('appends a searched tenant the filter did not catch', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })] }),
      tenantCandidates: [tenant({ contactId: 'cX', firstName: 'New', lastName: 'Tenant' })],
    });
    const addInput = screen.getByRole('combobox', { name: 'Add a tenant' });
    await u.type(addInput, 'New');
    await u.click(await screen.findByRole('option', { name: /New Tenant/ }));

    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    expect(within(list).getByText('New Tenant')).toBeInTheDocument();
    expect(within(list).getByText('Added')).toBeInTheDocument();
  });

  it('annotates a manually-added tenant already-sent via priorRecipientContactIds (unchecked)', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })],
        priorRecipientContactIds: ['cX'],
      }),
      tenantCandidates: [tenant({ contactId: 'cX', firstName: 'Prior', lastName: 'Sent' })],
    });
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'Prior');
    await u.click(await screen.findByRole('option', { name: /Prior Sent/ }));

    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    const row = within(list).getByText('Prior Sent').closest('li') as HTMLElement;
    expect(within(row).getByRole('checkbox')).not.toBeChecked();
    expect(within(row).getByText('Already sent')).toBeInTheDocument();
  });
});

describe('RecipientPreview — send posts the exact checked selection', () => {
  it('sends ONLY the checked ids: includes a manually-added one, excludes an unchecked + an already-sent one', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha' }), // checked
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002' }), // we'll uncheck
          candidate({ contactId: 'c3', firstName: 'AlreadySent', phone: '+14040000003', alreadySentThisProperty: true }), // stays unchecked
        ],
        priorRecipientContactIds: ['c3'],
      }),
      tenantCandidates: [tenant({ contactId: 'cX', firstName: 'Added', lastName: 'One' })],
    });
    const list = screen.getByRole('list', { name: 'Candidate recipients' });

    // Uncheck Bo.
    const bo = within(list).getByText('Bo').closest('li') as HTMLElement;
    await u.click(within(bo).getByRole('checkbox'));

    // Add a tenant the filter missed (added rows start checked).
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'Added');
    await u.click(await screen.findByRole('option', { name: /Added One/ }));

    // Send.
    await u.click(screen.getByRole('button', { name: /^Send to/ }));
    await waitFor(() => expect(sendBroadcast).toHaveBeenCalledTimes(1));
    const [draftId, ids] = sendBroadcast.mock.calls[0] as [string, string[]];
    expect(draftId).toBe('bcast_1');
    // c1 (checked) + cX (added, checked); NOT c2 (unchecked) NOT c3 (already-sent).
    expect(new Set(ids)).toEqual(new Set(['c1', 'cX']));
    // Lands on Results.
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/bcast_1'));
  });

  it('removing a row drops it from the send selection', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha' }),
          candidate({ contactId: 'c2', firstName: 'Bo', phone: '+14040000002' }),
        ],
      }),
    });
    await u.click(screen.getByRole('button', { name: 'Remove Bo' }));
    await u.click(screen.getByRole('button', { name: /^Send to/ }));
    await waitFor(() => expect(sendBroadcast).toHaveBeenCalled());
    const ids = (sendBroadcast.mock.calls[0] as [string, string[]])[1];
    expect(ids).toEqual(['c1']);
  });
});

describe('RecipientPreview — send errors', () => {
  it('surfaces 400 empty_audience inline', async () => {
    // Force checkedCount > 0 then bounce with empty_audience server-side.
    const u = userEvent.setup();
    sendBroadcast.mockRejectedValue(new ApiError(400, 'empty_audience', 'no recipients'));
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })] }),
    });
    await u.click(screen.getByRole('button', { name: /^Send to/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Nothing selected/i);
  });

  it('surfaces a 400 over-cap (cap) message inline', async () => {
    const u = userEvent.setup();
    sendBroadcast.mockRejectedValue(new ApiError(400, 'audience_too_large', 'audience exceeds the cap of 500'));
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })] }),
    });
    await u.click(screen.getByRole('button', { name: /^Send to/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/cap/i);
  });

  it('surfaces a 409 not-draft inline AND offers a Results link', async () => {
    const u = userEvent.setup();
    sendBroadcast.mockRejectedValue(new ApiError(409, 'broadcast_not_draft', 'already sent'));
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })] }),
    });
    await u.click(screen.getByRole('button', { name: /^Send to/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already sent/i);
    const viewResults = within(alert).getByRole('button', { name: /View results/i });
    await u.click(viewResults);
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/bcast_1'));
  });
});

describe('RecipientPreview — delete draft', () => {
  it('deletes the draft and routes back to the list', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })] }),
    });
    await u.click(screen.getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(deleteBroadcast).toHaveBeenCalledWith('bcast_1'));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts'));
  });

  it('routes to Results when delete 409s (no longer a draft)', async () => {
    const u = userEvent.setup();
    deleteBroadcast.mockRejectedValue(new ApiError(409, 'broadcast_not_draft', 'already sent'));
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })] }),
    });
    await u.click(screen.getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/broadcasts/bcast_1'));
  });
});
