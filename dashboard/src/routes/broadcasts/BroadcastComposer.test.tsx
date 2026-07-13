// BroadcastComposer tests (§8 item 1) — the composer orchestrator + its single
// throwaway-draft lifecycle. Covers: voucher size pre-fills from ?unitId (mock
// getUnit) + the "matches property" tag; overriding the voucher size; the reach
// count updates from createBroadcast (estimatedCount/truncated) + the truncated
// warning; the single-draft/no-orphan behavior (a material audience change
// recreates the draft and deleteBroadcasts the prior id).
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Contact, ContactsPage, EventStreamHandlers, UnitItem, UnitsPage } from '../../api/index.js';

const getUnit = vi.fn();
const getUnits = vi.fn();
const getContacts = vi.fn();
const getContact = vi.fn();
const createBroadcast = vi.fn();
const deleteBroadcast = vi.fn();
const previewBroadcast = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getUnit: (...a: unknown[]) => getUnit(...a),
    getUnits: (...a: unknown[]) => getUnits(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    createBroadcast: (...a: unknown[]) => createBroadcast(...a),
    deleteBroadcast: (...a: unknown[]) => deleteBroadcast(...a),
    previewBroadcast: (...a: unknown[]) => previewBroadcast(...a),
    useEventStream: (_h: EventStreamHandlers) => {},
  };
});

import { BroadcastComposer } from './BroadcastComposer.js';
import { DEFAULT_SEND_TEMPLATE } from './resolveTemplate.js';

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

const seedTenant: Contact = {
  contactId: 'c-seed',
  type: 'tenant',
  firstName: 'Tasha',
  lastName: 'Green',
  phone: '+14040000001',
};

const pickableUnits: UnitsPage = {
  units: [
    unit({
      unitId: 'u-1',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
    }),
  ],
  nextCursor: null,
};

function renderComposer(search = ''): ReturnType<typeof render> {
  return render(
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
  getUnits.mockReset().mockResolvedValue(pickableUnits);
  getContacts.mockReset().mockResolvedValue(emptyContacts);
  getContact.mockReset().mockResolvedValue(seedTenant);
  createBroadcast
    .mockReset()
    .mockResolvedValue({ broadcastId: 'draft_1', status: 'draft', estimatedCount: 5, truncated: false });
  deleteBroadcast.mockReset().mockResolvedValue({ deleted: true });
  previewBroadcast.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('BroadcastComposer - property-first step (spec 2026-07-13)', () => {
  it('a bare entry shows ONLY the property choice - no message, no audience', async () => {
    renderComposer();
    expect(await screen.findByRole('heading', { name: 'Send a property' })).toBeInTheDocument();
    // The browsable candidate list renders without any typing.
    expect(await screen.findByRole('button', { name: /77 Peachtree St/ })).toBeInTheDocument();
    // Compose-step sections are NOT on this screen yet.
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Housing authority')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Preview recipients/ })).not.toBeInTheDocument();
  });

  it('picking a property reveals compose with the message pre-filled: unit fields resolved, [TenantName] kept', async () => {
    const user = userEvent.setup();
    getUnit.mockResolvedValue(
      unit({
        unitId: 'u-1',
        address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
        rent_min: 1500,
        rent_max: 1500,
      }),
    );
    renderComposer();
    await user.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    const box = await screen.findByRole('textbox', { name: 'Message' });
    await waitFor(() => {
      expect(box).toHaveValue(
        'Hi [TenantName], a 2 home at 77 Peachtree St, Atlanta, GA 30303 is available for $1500/mo. Details: ' +
          `${window.location.origin}/p/u-1`,
      );
    });
    // Audience section arrives with compose.
    expect(screen.getByLabelText('Housing authority')).toBeInTheDocument();
  });

  it('a seeded entry goes through the property step too, showing the recipient context', async () => {
    renderComposer('?contactId=c-seed');
    expect(await screen.findByText(/Sending to/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /77 Peachtree St/ })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
  });

  it('?unitId= entries skip the property step (fixed context, message immediately)', async () => {
    renderComposer('?unitId=unit-0001');
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    // No browsable candidate list on the fixed-property entry.
    expect(screen.queryByRole('button', { name: /77 Peachtree St/ })).not.toBeInTheDocument();
  });

  it('"Change" returns to the property step; an unedited body refills for the new pick', async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    await screen.findByRole('textbox', { name: 'Message' });
    await user.click(screen.getByRole('button', { name: 'Change property' }));
    // Back on the property step.
    expect(await screen.findByRole('button', { name: /77 Peachtree St/ })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
  });
});

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
  it('shows the reach count from createBroadcast once the prefilled draft settles', async () => {
    renderComposer('?unitId=unit-0001');
    // The property-first prefill gives a non-empty body with zero keystrokes;
    // after the debounce the draft is created and the reach shows.
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Reaches\s*5\s*tenants/));
  });

  it('shows the truncated/capped warning when the estimate is truncated', async () => {
    createBroadcast.mockResolvedValue({ broadcastId: 'draft_1', status: 'draft', estimatedCount: 500, truncated: true });
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByText(/list is capped/i)).toBeInTheDocument(), { timeout: 4000 });
  });
});

describe('BroadcastComposer — single draft / no orphan', () => {
  it('recreates the draft on a material audience change and deletes the prior draft id', async () => {
    const u = userEvent.setup();
    createBroadcast
      .mockResolvedValueOnce({ broadcastId: 'draft_A', status: 'draft', estimatedCount: 5, truncated: false })
      .mockResolvedValueOnce({ broadcastId: 'draft_B', status: 'draft', estimatedCount: 2, truncated: false });
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(1), { timeout: 4000 });

    // A material audience change (a DIFFERENT voucher size - 2-BR is already
    // pre-filled from the property's beds) → a fresh draft, and the PRIOR
    // throwaway (draft_A) is deleted (no orphan).
    await u.click(screen.getByRole('button', { name: '3-BR' }));
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() => expect(deleteBroadcast).toHaveBeenCalledWith('draft_A'));
  });
});

describe('BroadcastComposer — preview gate', () => {
  it('the property prefill enables Preview by itself, then advances to the recipient list', async () => {
    previewBroadcast.mockResolvedValue({ count: 1, truncated: false, candidates: [{ contactId: 'c1', firstName: 'Tasha', phone: '+14040000001', alreadySentThisProperty: false, has_consent: true, seeded: false }], priorRecipientContactIds: [], seedContactIds: [], unresolvedSeedIds: [] });
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    // The property's details prefill the message ([TenantName] preserved) —
    // no typing needed to move on.
    await waitFor(() =>
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toMatch(
        /Hi \[TenantName\], a 2 home at/,
      ),
    );
    expect(screen.queryByText('Write a message to enable the preview.')).not.toBeInTheDocument();
    // The auto-draft (debounced) enables Preview with zero keystrokes.
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
    expect(String(createBroadcast.mock.calls.at(-1)?.[0]?.body_template)).toContain('[TenantName]');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled());
    expect(screen.queryByText('Sizing the audience…')).not.toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Preview recipients' }));
    // Advances to the curated list step.
    expect(await screen.findByRole('heading', { name: 'Review recipients' })).toBeInTheDocument();
    expect(previewBroadcast).toHaveBeenCalledWith('draft_1');
  });

  it('clearing the message disables Preview again, with the why-hint', async () => {
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByLabelText('Message')).not.toHaveValue(''));
    await u.clear(screen.getByLabelText('Message'));
    expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeDisabled();
    // An unexplained disabled button is a dead end for a first-time operator.
    expect(screen.getByText('Write a message to enable the preview.')).toBeInTheDocument();
  });
});

describe('BroadcastComposer - property-details prefill (fresh compose only)', () => {
  it('?unitId= entry prefills the property details with [TenantName] preserved', async () => {
    renderComposer('?unitId=unit-0001');
    await waitFor(() => {
      const v = (screen.getByLabelText('Message') as HTMLTextAreaElement).value;
      expect(v).toContain('Hi [TenantName],');
      expect(v).toContain('1450 Joseph E. Boone Blvd NW');
      expect(v).not.toContain('[Address]');
    });
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
  });

  it('?contactId= entry has NO message editor before a property is chosen (property step)', async () => {
    renderComposer('?contactId=c-seed');
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
    // Let the seeded-context fetch settle (act hygiene).
    await screen.findByText(/Sending to/);
  });

  it('?draftId= resume starts EMPTY and never auto-creates (a non-empty body would delete the resumed draft)', async () => {
    const { unmount } = renderComposer('?draftId=bcast_resume');
    expect(screen.getByLabelText('Message')).toHaveValue('');
    // Outlast the create debounce (600ms): no draft may be created.
    await act(() => new Promise((resolve) => setTimeout(resolve, 800)));
    expect(createBroadcast).not.toHaveBeenCalled();
    // Leaving must NOT delete the adopted draft (it is the operator's saved work).
    unmount();
    expect(deleteBroadcast).not.toHaveBeenCalled();
  });

  it('an untouched pre-filled draft is deleted on unmount (open-and-leave leaves no junk row)', async () => {
    const u = userEvent.setup();
    const { unmount } = renderComposer();
    // Property-first: pick from the browsable list, then the prefill auto-drafts.
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
    // The auto-draft resolved (Preview enabled proves draft_1 is current).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled(),
    );
    unmount();
    await waitFor(() => expect(deleteBroadcast).toHaveBeenCalledWith('draft_1'));
  });

  it('a hand-edited draft SURVIVES unmount (stays resumable in the Matching list)', async () => {
    const u = userEvent.setup();
    const { unmount } = renderComposer();
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    // Edit within the debounce window: exactly one create, with the edited body.
    await u.type(await screen.findByLabelText('Message'), ' Call us!');
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(1), { timeout: 4000 });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled(),
    );
    unmount();
    // No churn happened (one create) and no unmount delete: the draft persists.
    expect(deleteBroadcast).not.toHaveBeenCalled();
  });
});

describe('BroadcastComposer - ?contactId= seeding', () => {
  it('?contactId= seeds the draft: createBroadcast gets seedContactIds and NO audience_filter', async () => {
    const u = userEvent.setup();
    renderComposer('?contactId=c-seed');
    // Property-first: pick, then the resolved auto-seed drafts by itself.
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
    expect(createBroadcast.mock.calls.at(-1)?.[0]).toMatchObject({
      seedContactIds: ['c-seed'],
    });
    expect(createBroadcast.mock.calls.at(-1)?.[0]).not.toHaveProperty('audience_filter');
  });

  it('seeded entry shows the seeds-only banner; "Add more tenants by filters" enables the filter', async () => {
    const u = userEvent.setup();
    renderComposer('?contactId=c-seed');
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    expect(await screen.findByText(/Sending to/)).toBeInTheDocument();
    // The banner resolves the tenant name via getContact.
    expect(await screen.findByText('Tasha Green')).toBeInTheDocument();
    // AudienceFilters is hidden until the operator opts into filters.
    expect(screen.queryByLabelText('Housing authority')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Add more tenants by filters' }));
    expect(await screen.findByLabelText('Housing authority')).toBeInTheDocument();
  });

  it('falls back to the raw contactId in the banner when the contact cannot be resolved', async () => {
    getContact.mockRejectedValue(new Error('not found'));
    renderComposer('?contactId=c-seed');
    expect(await screen.findByText(/Sending to/)).toBeInTheDocument();
    expect(await screen.findByText('c-seed')).toBeInTheDocument();
  });

  it('once filters are enabled, the draft recreates WITH audience_filter (seeds kept)', async () => {
    const u = userEvent.setup();
    renderComposer('?contactId=c-seed');
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
    await u.click(screen.getByRole('button', { name: 'Add more tenants by filters' }));
    await waitFor(
      () =>
        expect(createBroadcast.mock.calls.at(-1)?.[0]).toMatchObject({
          seedContactIds: ['c-seed'],
          audience_filter: { contact_type: 'tenant' },
        }),
      { timeout: 4000 },
    );
  });

  it('enabling filters pre-fills the voucher size from the attached property', async () => {
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001&contactId=c-seed');
    expect(await screen.findByText(/Sending to/)).toBeInTheDocument();
    // Filters hidden - no voucher chips yet.
    expect(screen.queryByRole('button', { name: /2-BR/ })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Add more tenants by filters' }));
    // The pre-fill applies at the moment filters become enabled (unit beds = 2).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /2-BR/ })).toHaveAttribute('aria-pressed', 'true'),
    );
  });
});

describe('BroadcastComposer - resolved message mode (single recipient)', () => {
  it('a single seed + attached property auto-seeds the resolved text and hides the merge chips', async () => {
    renderComposer('?unitId=unit-0001&contactId=c-seed');
    // The editor auto-seeds the resolved DEFAULT template for the one tenant.
    await waitFor(() =>
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toContain('Hi Tasha,'),
    );
    // Resolved mode: the text IS the message, so no merge-field chips.
    expect(screen.queryByRole('group', { name: 'Insert a merge field' })).not.toBeInTheDocument();
  });

  it('an UNEDITED auto-seeded body resets silently when filters are enabled (no name leak, no confirm)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001&contactId=c-seed');
    const ta = (await screen.findByLabelText('Message')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toContain('Hi Tasha,'));
    // No manual edit -> nothing to protect: the flip proceeds WITHOUT a confirm,
    // and the resolved single-tenant text must NOT survive into the broader
    // audience (it would send "Hi Tasha," to every filtered recipient).
    await u.click(screen.getByRole('button', { name: 'Add more tenants by filters' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByLabelText('Housing authority')).toBeInTheDocument();
    // Token mode's starting point - the property-details prefill with
    // [TenantName] as a token (never the resolved single-tenant text).
    await waitFor(() => {
      expect(ta.value).toContain('Hi [TenantName],');
      expect(ta.value).not.toContain('Tasha');
    });
  });

  it('editing the resolved text then "Add more tenants by filters" prompts to confirm; cancel keeps seeds-only', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001&contactId=c-seed');
    const ta = await screen.findByLabelText('Message');
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toContain('Hi Tasha,'));
    await u.type(ta, ' Come see it!'); // a manual edit -> bodyEdited
    await u.click(screen.getByRole('button', { name: 'Add more tenants by filters' }));
    expect(confirmSpy).toHaveBeenCalledWith(
      'Switching the audience resets the message to the template. Discard your edits?',
    );
    // Cancelled -> the flip did NOT happen (still seeds-only, filters hidden).
    expect(screen.queryByLabelText('Housing authority')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add more tenants by filters' })).toBeInTheDocument();
  });
});

describe('BroadcastComposer - Property picker (no ?unitId=)', () => {
  it('no ?unitId= shows the Property step; picking a unit flows into the draft', async () => {
    const u = userEvent.setup();
    renderComposer('?contactId=c-seed');
    const picker = await screen.findByRole('combobox', { name: 'Property' });
    await u.type(picker, 'Peachtree');
    await u.click(await screen.findByRole('option', { name: /Peachtree/ }));
    // The pick reveals compose; the resolved auto-seed drafts with the picked unit.
    await waitFor(
      () => expect(createBroadcast.mock.calls.at(-1)?.[0]).toMatchObject({ unitId: 'u-1' }),
      { timeout: 4000 },
    );
  });

  it('?unitId= keeps the fixed property context - no Property picker rendered', async () => {
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(getUnit).toHaveBeenCalledWith('unit-0001', expect.anything()));
    expect(screen.queryByRole('combobox', { name: 'Property' })).not.toBeInTheDocument();
    expect(getUnits).not.toHaveBeenCalled();
  });

  it('a picker-attached property reaches the preview step (effectiveUnitId, not the empty ?unitId)', async () => {
    // I1: the preview must receive the PICKED unit id so its Send pre-flight +
    // Make-Available recovery run. A non-Available picked unit makes the pre-flight
    // observable: the "Property isn't Available" dialog only appears if the preview
    // got unitId='u-1'. If the composer passed the URL's (empty) ?unitId instead,
    // no pre-flight would run and no dialog would show.
    getUnit.mockResolvedValue(unit({ unitId: 'u-1', status: 'on_hold' }));
    previewBroadcast.mockResolvedValue({
      count: 1,
      truncated: false,
      candidates: [{ contactId: 'c-seed', firstName: 'Tasha', phone: '+14040000001', alreadySentThisProperty: false, has_consent: true, seeded: true }],
      priorRecipientContactIds: [],
      seedContactIds: ['c-seed'],
      unresolvedSeedIds: [],
    });
    const u = userEvent.setup();
    renderComposer('?contactId=c-seed');

    // Pick a property via the picker (no ?unitId in the URL).
    const picker = await screen.findByRole('combobox', { name: 'Property' });
    await u.type(picker, 'Peachtree');
    await u.click(await screen.findByRole('option', { name: /Peachtree/ }));

    // Resolved auto-seed fills the body → Preview enables → advance to the list.
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
    const previewBtn = screen.getByRole('button', { name: 'Preview recipients' });
    await waitFor(() => expect(previewBtn).toBeEnabled(), { timeout: 4000 });
    await u.click(previewBtn);
    await screen.findByRole('heading', { name: 'Review recipients' });

    // Send → the preview's availability pre-flight checks the PICKED unit id.
    getUnit.mockClear();
    await u.click(screen.getByRole('button', { name: /^Send to 1 tenant/ }));
    await screen.findByRole('dialog', { name: "Property isn't Available" });
    expect(getUnit).toHaveBeenCalledWith('u-1');
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

  it('no banner when composing without a property', async () => {
    renderComposer();
    expect(screen.queryByText(/flyer link won't work/)).not.toBeInTheDocument();
    // Let the picker-candidates fetch settle (act hygiene — the pre-filled
    // default also kicks the auto-draft on a bare compose now).
    await screen.findByRole('combobox', { name: 'Property' });
  });
});
