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
    has_consent: true,
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
    // Default: consent recorded, so the add-a-tenant flow succeeds. Tests that
    // exercise the no-consent guard override consent_method to undefined.
    consent_method: 'verbal_phone',
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
    // Each checkbox has a clean per-tenant accessible name (NOT the whole row).
    expect(within(list).getByRole('checkbox', { name: 'Tasha' })).toBeInTheDocument();
    expect(within(list).getByRole('checkbox', { name: 'Bo' })).toBeInTheDocument();
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

  it('does NOT add an opted-out tenant — surfaces an inline reason instead', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })] }),
      tenantCandidates: [tenant({ contactId: 'cX', firstName: 'Opted', lastName: 'Out', sms_opt_out: true })],
    });
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'Opted');
    await u.click(await screen.findByRole('option', { name: /Opted Out/ }));

    // Not added to the sendable list (count stays at the lone candidate).
    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    expect(within(list).queryByText('Opted Out')).not.toBeInTheDocument();
    // An inline reason surfaces (not a silent failure).
    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent(/opted out/i);
    // The "Send to N" count was NOT inflated (still 1 — just Tasha).
    expect(screen.getByRole('button', { name: 'Send to 1 tenant' })).toBeInTheDocument();
  });

  it('does NOT add an unreachable tenant — surfaces an inline reason', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })] }),
      tenantCandidates: [tenant({ contactId: 'cX', firstName: 'Bad', lastName: 'Number', sms_unreachable: true })],
    });
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'Bad');
    await u.click(await screen.findByRole('option', { name: /Bad Number/ }));

    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    expect(within(list).queryByText('Bad Number')).not.toBeInTheDocument();
    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent(/unreachable/i);
  });

  it('does NOT add a no-consent tenant — surfaces "no consent recorded" inline', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })] }),
      // consent_method undefined → no recorded consent.
      tenantCandidates: [
        tenant({ contactId: 'cX', firstName: 'No', lastName: 'Consent', consent_method: undefined }),
      ],
    });
    await u.type(screen.getByRole('combobox', { name: 'Add a tenant' }), 'No');
    await u.click(await screen.findByRole('option', { name: /No Consent/ }));

    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    expect(within(list).queryByText('No Consent')).not.toBeInTheDocument();
    const note = await screen.findByRole('alert');
    expect(note).toHaveTextContent(/no consent recorded/i);
    // The sendable count is not inflated (still just Tasha).
    expect(screen.getByRole('button', { name: 'Send to 1 tenant' })).toBeInTheDocument();
  });
});

// ── A2P/CTIA consent treatment (§4) ─────────────────────────────────────────
describe('RecipientPreview — consent treatment', () => {
  it('badges a no-consent candidate, disables + unchecks it, and shows the count', () => {
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha' }),
          candidate({ contactId: 'c2', firstName: 'NoConsent', phone: '+14040000002', has_consent: false }),
        ],
      }),
    });
    const list = screen.getByRole('list', { name: 'Candidate recipients' });
    // The no-consent row carries the "consent not recorded — fix before sending"
    // treatment, is unchecked, and is disabled (a hard fence).
    expect(within(list).getByText(/consent not recorded — fix before sending/i)).toBeInTheDocument();
    const noConsentBox = within(list).getByRole('checkbox', { name: /NoConsent — consent not recorded/i });
    expect(noConsentBox).not.toBeChecked();
    expect(noConsentBox).toBeDisabled();
    // The count of no-consent recipients is surfaced.
    expect(screen.getByText(/1 recipient without recorded consent/i)).toBeInTheDocument();
  });

  it('excludes no-consent candidates from the send (only consented ids are posted)', async () => {
    const u = userEvent.setup();
    renderPreview({
      preview: previewOf({
        candidates: [
          candidate({ contactId: 'c1', firstName: 'Tasha' }),
          candidate({ contactId: 'c2', firstName: 'NoConsent', phone: '+14040000002', has_consent: false }),
        ],
      }),
    });
    // Only Tasha is checkable → "Send to 1 tenant". Try Select all — the
    // no-consent row must still be excluded.
    await u.click(screen.getByRole('button', { name: 'Select all' }));
    await u.click(screen.getByRole('button', { name: /^Send to/ }));
    await waitFor(() => expect(sendBroadcast).toHaveBeenCalledTimes(1));
    const [, ids] = sendBroadcast.mock.calls[0] as [string, string[]];
    expect(new Set(ids)).toEqual(new Set(['c1']));
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

  it('surfaces a 429 rate_limited inline AND re-enables Send (not stuck)', async () => {
    const u = userEvent.setup();
    sendBroadcast.mockRejectedValue(new ApiError(429, 'rate_limited', 'rate limited'));
    renderPreview({
      preview: previewOf({ candidates: [candidate({ contactId: 'c1', firstName: 'Tasha' })] }),
    });
    await u.click(screen.getByRole('button', { name: /^Send to/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sending too fast — wait a moment and try again.');
    // The busy flag reset — the Send control is back and enabled, not stuck on "Sending…".
    expect(screen.getByRole('button', { name: 'Send to 1 tenant' })).toBeEnabled();
    // No stray Results link (that's the 409 affordance, not a rate limit).
    expect(within(alert).queryByRole('button', { name: /View results/i })).not.toBeInTheDocument();
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
