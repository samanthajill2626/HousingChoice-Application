// BroadcastComposer tests (§8 item 1) — the composer orchestrator + its single
// throwaway-draft lifecycle. Covers: voucher size pre-fills from ?unitId (mock
// getUnit) + the "matches property" tag; overriding the voucher size; the reach
// count updates from createBroadcast (estimatedCount/truncated) + the truncated
// warning; the single-draft/no-orphan behavior (a material audience change
// recreates the draft and deleteBroadcasts the prior id).
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Contact, EventStreamHandlers, OrgEntry, UnitItem } from '../../api/index.js';
import { ApiError } from '../../api/index.js';

const getUnit = vi.fn();
const getAllUnits = vi.fn();
const getAllContacts = vi.fn();
const getContact = vi.fn();
const createBroadcast = vi.fn();
const deleteBroadcast = vi.fn();
const previewBroadcast = vi.fn();
// RecipientPreview's Send (the review step).
const sendBroadcast = vi.fn();
// AudienceFilters' housing authority picker reads the list (spec 2026-10-06 D7).
const getOrgList = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getUnit: (...a: unknown[]) => getUnit(...a),
    getAllUnits: (...a: unknown[]) => getAllUnits(...a),
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
    getContact: (...a: unknown[]) => getContact(...a),
    createBroadcast: (...a: unknown[]) => createBroadcast(...a),
    deleteBroadcast: (...a: unknown[]) => deleteBroadcast(...a),
    previewBroadcast: (...a: unknown[]) => previewBroadcast(...a),
    sendBroadcast: (...a: unknown[]) => sendBroadcast(...a),
    getOrgList: (...a: unknown[]) => getOrgList(...a),
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

const emptyContacts: Contact[] = [];

const seedTenant: Contact = {
  contactId: 'c-seed',
  type: 'tenant',
  firstName: 'Tasha',
  lastName: 'Green',
  phone: '+14040000001',
};

const pickableUnits: UnitItem[] = [
    unit({
      unitId: 'u-1',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
    }),
  ];

/** A housing authority entry of the organization list. */
function orgEntry(orgId: string, name: string, spellings: string[] = []): OrgEntry {
  return {
    orgId,
    kind: 'housing_authority',
    name,
    spellings,
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
}

/** A promise the test settles by hand - resolved, or rejected (a refusal
 *  that lands late, matching-blast-rules AR39). */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Outlast the composer's 600 ms create debounce: a draft that could be made
 *  has been made by now. */
async function outlastCreateDebounce(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 800));
  });
}

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
  getAllUnits.mockReset().mockResolvedValue(pickableUnits);
  getAllContacts.mockReset().mockResolvedValue(emptyContacts);
  getContact.mockReset().mockResolvedValue(seedTenant);
  createBroadcast
    .mockReset()
    .mockResolvedValue({ broadcastId: 'draft_1', status: 'draft', estimatedCount: 5, truncated: false });
  deleteBroadcast.mockReset().mockResolvedValue({ deleted: true });
  previewBroadcast.mockReset();
  sendBroadcast.mockReset().mockResolvedValue({});
  getOrgList.mockReset().mockResolvedValue({ version: 1, entries: [] });
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
    expect(screen.queryByLabelText('Housing authorities')).not.toBeInTheDocument();
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
        'Hi [TenantName], a 2-bedroom home at 77 Peachtree St, Atlanta, GA 30303 is available for $1500/mo. Details: ' +
          `${window.location.origin}/p/u-1`,
      );
    });
    // Audience section arrives with compose.
    expect(screen.getByLabelText('Housing authorities')).toBeInTheDocument();
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
  it('pre-fills the voucher size from the unit beds when none is recorded + tags the matching chip', async () => {
    renderComposer('?unitId=unit-0001');
    // getUnit fetched the unit (beds 2, no recorded voucher size) -> the 2-BR
    // chip is pressed + tagged.
    await waitFor(() => {
      const chip = screen.getByRole('button', { name: /2-BR/ });
      expect(chip).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByText(/matches property/i)).toBeInTheDocument();
    expect(screen.getByText(/Pre-filled to the 2-bedroom voucher this property takes/i)).toBeInTheDocument();
    expect(getUnit).toHaveBeenCalledWith('unit-0001', expect.anything());
  });

  it('pre-fills the RECORDED voucher size over the bedroom count + tags that chip', async () => {
    // The 2026-10-12 report: a property with its own voucher size was matched
    // on its bedrooms. beds 2, recorded size 3 -> the 3-BR chip, not the 2-BR one.
    getUnit.mockResolvedValue(unit({ voucher_size_accepted: 3 }));
    renderComposer('?unitId=unit-0001');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^3-BR/ })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(screen.getByRole('button', { name: /^3-BR/ })).toHaveTextContent(/matches property/i);
    expect(screen.getByRole('button', { name: /^2-BR/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /^2-BR/ })).not.toHaveTextContent(/matches property/i);
    expect(screen.getByText(/Pre-filled to the 3-bedroom voucher this property takes/i)).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Reaches\s*5\s*recipients/));
  });

  it('shows the truncated/capped warning when the estimate is truncated', async () => {
    createBroadcast.mockResolvedValue({ broadcastId: 'draft_1', status: 'draft', estimatedCount: 500, truncated: true });
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByText(/the list is incomplete/)).toBeInTheDocument(), { timeout: 4000 });
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
    previewBroadcast.mockResolvedValue({ count: 1, truncated: false, candidates: [{ contactId: 'c1', firstName: 'Tasha', phone: '+14040000001', alreadySentThisProperty: false, has_consent: true, seeded: false, declinedThisProperty: false, checkedByDefault: true }], priorRecipientContactIds: [], seedContactIds: [], unresolvedSeedIds: [], declinedContactIds: [], tourHolds: [] });
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    // The property's details prefill the message ([TenantName] preserved) —
    // no typing needed to move on.
    await waitFor(() =>
      expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toMatch(
        /Hi \[TenantName\], a 2-bedroom home at/,
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
    expect(screen.queryByLabelText('Housing authorities')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Add more tenants by filters' }));
    expect(await screen.findByLabelText('Housing authorities')).toBeInTheDocument();
  });

  it('(PIN) caseworkers D20: a PARTNER ?contactId= seeds the draft and the banner names the partner (no type gate)', async () => {
    getContact.mockResolvedValue({
      contactId: 'c-partner',
      type: 'partner',
      firstName: 'Cora',
      lastName: 'Reyes',
      phone: '+14040000002',
    });
    const u = userEvent.setup();
    renderComposer('?contactId=c-partner');
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    expect(await screen.findByText(/Sending to/)).toBeInTheDocument();
    expect(await screen.findByText('Cora Reyes')).toBeInTheDocument();
    await waitFor(() => expect(createBroadcast).toHaveBeenCalled(), { timeout: 4000 });
    expect(createBroadcast.mock.calls.at(-1)?.[0]).toMatchObject({ seedContactIds: ['c-partner'] });
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
    // share-skip-fix D8: the one-recipient default is the address + the flyer
    // link, nothing else - no greeting, no beds, no rent. (The fallback link:
    // this file's createBroadcast mock returns no flyerUrl.)
    await waitFor(() => {
      const v = (screen.getByLabelText('Message') as HTMLTextAreaElement).value;
      expect(v).toMatch(/^1450 Joseph E\. Boone Blvd NW, Atlanta, GA 30314 \S+\/p\/unit-0001$/);
    });
    // Resolved mode: the text IS the message, so no merge-field chips.
    expect(screen.queryByRole('group', { name: 'Insert a merge field' })).not.toBeInTheDocument();
  });

  it('an UNEDITED auto-seeded body resets silently when filters are enabled (no name leak, no confirm)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001&contactId=c-seed');
    const ta = (await screen.findByLabelText('Message')) as HTMLTextAreaElement;
    await waitFor(() => expect(ta.value).toMatch(/^1450 Joseph E\. Boone Blvd NW/));
    // No manual edit -> nothing to protect: the flip proceeds WITHOUT a confirm,
    // and the resolved one-to-one text (composed for this one tenant) must NOT
    // survive into the broader audience - the blast default takes over.
    await u.click(screen.getByRole('button', { name: 'Add more tenants by filters' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByLabelText('Housing authorities')).toBeInTheDocument();
    // Token mode's starting point - the property-details prefill with
    // [TenantName] as a token (never the resolved single-tenant text).
    await waitFor(() => {
      expect(ta.value).toContain('Hi [TenantName],');
      expect(ta.value).not.toMatch(/^1450 Joseph/);
      expect(ta.value).not.toContain('Tasha');
    });
  });

  it('editing the resolved text then "Add more tenants by filters" prompts to confirm; cancel keeps seeds-only', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001&contactId=c-seed');
    const ta = await screen.findByLabelText('Message');
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toMatch(/^1450 Joseph E\. Boone Blvd NW/));
    await u.type(ta, ' Come see it!'); // a manual edit -> bodyEdited
    await u.click(screen.getByRole('button', { name: 'Add more tenants by filters' }));
    expect(confirmSpy).toHaveBeenCalledWith(
      'Switching the audience resets the message to the template. Discard your edits?',
    );
    // Cancelled -> the flip did NOT happen (still seeds-only, filters hidden).
    expect(screen.queryByLabelText('Housing authorities')).not.toBeInTheDocument();
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
    expect(getAllUnits).not.toHaveBeenCalled();
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
      candidates: [{ contactId: 'c-seed', firstName: 'Tasha', phone: '+14040000001', alreadySentThisProperty: false, has_consent: true, seeded: true, declinedThisProperty: false, checkedByDefault: true }],
      priorRecipientContactIds: [],
      seedContactIds: ['c-seed'],
      unresolvedSeedIds: [],
      declinedContactIds: [],
      tourHolds: [],
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
    await u.click(screen.getByRole('button', { name: /^Send to 1 recipient/ }));
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

// The property step against a REAL portfolio (the Quo import landed ~100
// properties). Two independent caps used to hide them: the candidate fetch took
// only the FIRST server page (<=50, no cursor walk), and the browse list sliced
// to 12 with no way to see the rest. Browsing stays capped at 12 by default -
// that is the deliberate "don't dump 100 rows" default - but "Load more" reveals
// the next batch, and a typed query matches across the WHOLE portfolio.
describe('BroadcastComposer — property picker at portfolio scale', () => {
  /** n browsable properties, addresses numbered so each label is unique. */
  function manyUnits(n: number): UnitItem[] {
    return Array.from({ length: n }, (_, i) =>
      unit({
        unitId: `u-${i + 1}`,
        address: { line1: `${100 + i} Sample St`, city: 'Atlanta', state: 'GA', zip: '30303' },
      }),
    );
  }

  /** The browse-list rows (the picker's own dropdown renders `option`s, not buttons). */
  function propertyRows(): HTMLElement[] {
    return screen.getAllByRole('button', { name: /Sample St|Findme Ave/ });
  }

  it('browses the first 12 of a 100-property portfolio and says how many there are', async () => {
    getAllUnits.mockResolvedValue(manyUnits(100));
    renderComposer();
    await screen.findByRole('combobox', { name: 'Property' });
    await waitFor(() => expect(propertyRows()).toHaveLength(12));
    expect(screen.getByText(/Showing 12 of 100/)).toBeInTheDocument();
  });

  it('"Load more" reveals the next batch of properties', async () => {
    const user = userEvent.setup();
    getAllUnits.mockResolvedValue(manyUnits(100));
    renderComposer();
    await waitFor(() => expect(propertyRows()).toHaveLength(12));

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(propertyRows()).toHaveLength(24));
    expect(screen.getByText(/Showing 24 of 100/)).toBeInTheDocument();
  });

  it('hides "Load more" once every property is on screen', async () => {
    getAllUnits.mockResolvedValue(manyUnits(8));
    renderComposer();
    await waitFor(() => expect(propertyRows()).toHaveLength(8));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing 8 of 8/)).not.toBeInTheDocument();
  });

  it('a typed query matches a property far past the browsable 12', async () => {
    const user = userEvent.setup();
    const units = manyUnits(100);
    units[80] = unit({
      unitId: 'u-findme',
      address: { line1: '900 Findme Ave', city: 'Atlanta', state: 'GA', zip: '30310' },
    });
    getAllUnits.mockResolvedValue(units);
    renderComposer();
    await waitFor(() => expect(propertyRows()).toHaveLength(12));

    await user.type(screen.getByRole('combobox', { name: 'Property' }), 'Findme');
    await waitFor(() => expect(propertyRows()).toHaveLength(1));
    expect(propertyRows()[0]).toHaveAccessibleName(/900 Findme Ave/);
  });

  it('a new query re-opens the browse list at 12 rather than keeping the revealed count', async () => {
    const user = userEvent.setup();
    getAllUnits.mockResolvedValue(manyUnits(100));
    renderComposer();
    await waitFor(() => expect(propertyRows()).toHaveLength(12));
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(propertyRows()).toHaveLength(24));

    // "Sample St" matches all 100 — the reveal counter resets for the new query.
    await user.type(screen.getByRole('combobox', { name: 'Property' }), 'Sample St');
    await waitFor(() => expect(screen.getByText(/Showing 12 of 100/)).toBeInTheDocument());
    expect(propertyRows()).toHaveLength(12);
  });

  it('can pick a property that only a paged read could have supplied', async () => {
    // getAllUnits arrives already walked (api/lists.test.ts proves the walk).
    // Here: a roster larger than one server page stays fully searchable, because
    // the picker filters this array CLIENT-side - a unit missing from it is not
    // merely unbrowsable but unfindable.
    const user = userEvent.setup();
    getAllUnits.mockResolvedValue([
        ...manyUnits(50),
        unit({
          unitId: 'u-findme',
          address: { line1: '900 Findme Ave', city: 'Atlanta', state: 'GA', zip: '30310' },
        }),
      ]);
    renderComposer();
    await waitFor(() => expect(propertyRows()).toHaveLength(12));
    // 51 properties - more than one server page could have supplied.
    expect(screen.getByText(/Showing 12 of 51/)).toBeInTheDocument();

    await user.type(screen.getByRole('combobox', { name: 'Property' }), 'Findme');
    await waitFor(() => expect(propertyRows()).toHaveLength(1));
    expect(propertyRows()[0]).toHaveAccessibleName(/900 Findme Ave/);
  });
});

// Spec 2026-10-06 D7, matching-blast-rules D3b: a member of the housing
// authority filter can leave the list between the pick and the server's check
// (the draft create, or Preview). THAT member alone is removed; the others
// stay, and the removal is an edit (the prefill never puts it back).
describe('BroadcastComposer - a housing authority that left the list (matching-blast-rules D3b)', () => {
  const ATLANTA = orgEntry('o-atl', 'Atlanta Housing Authority', ['AHA']);
  const DEKALB = orgEntry('o-dek', 'DeKalb County Housing Authority', ['HADC']);
  const GONE = 'DeKalb County Housing Authority is no longer on the organization list, so it was removed from the filter.';
  const refused = (text: string): ApiError =>
    new ApiError(422, 'org_not_on_list', 'org_not_on_list', {
      error: 'org_not_on_list',
      field: 'audience_filter',
      text,
      candidates: [],
      close: [],
    });
  const preview = (): HTMLElement => screen.getByRole('button', { name: 'Preview recipients' });

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: [ATLANTA, DEKALB] });
    getUnit.mockResolvedValue(
      unit({ accepted_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'] }),
    );
  });

  it('a refused draft create removes ONLY the named member, says so, and the next draft keeps the others', async () => {
    const u = userEvent.setup();
    createBroadcast.mockImplementation(async (body: { audience_filter?: { housing_authorities?: string[] } }) => {
      if (body.audience_filter?.housing_authorities?.includes('DeKalb County Housing Authority') === true) {
        throw refused('DeKalb County Housing Authority');
      }
      return { broadcastId: 'draft_1', status: 'draft', estimatedCount: 5, truncated: false };
    });
    renderComposer('?unitId=unit-0001');
    expect(await screen.findByText(GONE, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove DeKalb County Housing Authority' })).not.toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(createBroadcast.mock.calls.at(-1)?.[0]?.audience_filter).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 2,
    });
    // Never the raw code.
    expect(screen.queryByText(/org_not_on_list/)).not.toBeInTheDocument();
    // The next filter change clears the message; DeKalb stays out (an edit).
    await u.click(screen.getByRole('button', { name: /^3-BR/ }));
    expect(screen.queryByText(GONE)).not.toBeInTheDocument();
    await waitFor(
      () =>
        expect(createBroadcast.mock.calls.at(-1)?.[0]?.audience_filter).toEqual({
          contact_type: 'tenant',
          housing_authorities: ['Atlanta Housing Authority'],
          bedroomSize: 3,
        }),
      { timeout: 4000 },
    );
  });

  it('a refused Preview removes ONLY the named member, says so, and recreates the draft without it', async () => {
    const u = userEvent.setup();
    previewBroadcast.mockRejectedValue(refused('DeKalb County Housing Authority'));
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(createBroadcast).toHaveBeenCalledTimes(1);
    expect(createBroadcast.mock.calls[0]?.[0]?.audience_filter).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority', 'DeKalb County Housing Authority'],
      bedroomSize: 2,
    });
    await u.click(preview());
    expect(await screen.findByText(GONE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove DeKalb County Housing Authority' })).not.toBeInTheDocument();
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(createBroadcast.mock.calls[1]?.[0]?.audience_filter).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 2,
    });
    expect(screen.queryByText(/org_not_on_list/)).not.toBeInTheDocument();
  });

  // matching-blast-rules AR39: a refusal belongs to the property its Preview
  // was made for. Change property stays enabled while a Preview loads (AR33),
  // so a 422 can land after staff picked ANOTHER property: it removes nothing
  // from that property's filter and says nothing there.
  it('a refused Preview that lands after a change to a DIFFERENT property changes nothing there and says nothing', async () => {
    const u = userEvent.setup();
    const peach = unit({
      unitId: 'u-1',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
      accepted_authorities: ['DeKalb County Housing Authority'],
    });
    const oak = unit({
      unitId: 'u-2',
      address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' },
      accepted_authorities: ['Atlanta Housing Authority'],
    });
    getAllUnits.mockResolvedValue([peach, oak]);
    getUnit.mockImplementation(async (id: string) => (id === 'u-2' ? oak : peach));
    renderComposer();
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    expect(await screen.findByRole('button', { name: 'Remove DeKalb County Housing Authority' })).toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    const held = deferred<unknown>();
    previewBroadcast.mockReturnValueOnce(held.promise);
    await u.click(preview());
    // Change stays enabled while the Preview loads: staff move on to 12 Oak St.
    await u.click(screen.getByRole('button', { name: 'Change property' }));
    await u.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    expect(await screen.findByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    // Only now is 77 Peachtree's Preview refused - for DeKalb.
    await act(async () => held.reject(refused('DeKalb County Housing Authority')));
    // 12 Oak St keeps exactly its own prefill, and nothing is said.
    expect(screen.getAllByRole('button', { name: /^Remove / }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove Atlanta Housing Authority',
    ]);
    expect(screen.queryByText(/is no longer on the organization list/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Every draft made for 12 Oak St carries its prefill.
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    const oakDrafts = createBroadcast.mock.calls
      .map(([body]) => body as { unitId?: string; audience_filter?: { housing_authorities?: string[] } })
      .filter((body) => body.unitId === 'u-2');
    expect(oakDrafts.length).toBeGreaterThan(0);
    for (const body of oakDrafts) {
      expect(body.audience_filter?.housing_authorities).toEqual(['Atlanta Housing Authority']);
    }
  });
});

// matching-blast-rules D3: the composer fills the housing authorities (and the
// voucher size, D3a) from the property. The prefill BELONGS TO THE PROPERTY:
// staff edits win while it stays; a DIFFERENT property empties both filters at
// once and its prefill fills them when it loads. Preview waits for the prefill
// ONLY with a property attached and the filters on - and no draft is made
// while it waits (AR23). A FAILED read holds it too, with a notice and a Try
// again that re-runs only that read (AR44, spec revision 7).
describe('BroadcastComposer - the property prefill (matching-blast-rules D3)', () => {
  const ATLANTA = orgEntry('o-atl', 'Atlanta Housing Authority', ['AHA']);
  const DEKALB = orgEntry('o-dek', 'DeKalb County Housing Authority', ['HADC']);
  const PROPERTY_HOLD =
    "Couldn't load the property, so its housing authorities and voucher size can't be filled in yet.";
  const LIST_HOLD =
    "Couldn't load the organization list, so housing authorities can't be filled in from the property yet.";
  const failed500 = (): ApiError => new ApiError(500, 'http_500', 'Request failed (500)');
  const preview = (): HTMLElement => screen.getByRole('button', { name: 'Preview recipients' });
  const lastDraftFilter = (): unknown =>
    (createBroadcast.mock.calls.at(-1)?.[0] as { audience_filter?: unknown } | undefined)?.audience_filter;
  /** The prefill holds: no draft was made (one that could be made has been
   *  made by now), Preview is disabled, and the reach line reads pending. */
  async function expectHeld(): Promise<void> {
    await outlastCreateDebounce();
    expect(createBroadcast).not.toHaveBeenCalled();
    expect(preview()).toBeDisabled();
    // The spinner beside Preview is another role="status": match the text.
    expect(screen.getByText(/Estimating reach/)).toBeInTheDocument();
  }
  /** FW2-1: while a failed read's notice holds the prefill, the Preview area
   *  offers no remedy - no hint under Preview (writing a message, clearing
   *  typed text or waiting does not end a hold; Try again does) and no
   *  spinner beside it (the Spinner is the role="status" named Loading). */
  function expectNoPreviewHint(): void {
    expect(screen.queryByText('Write a message to enable the preview.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Sizing the audience/)).not.toBeInTheDocument();
    expect(screen.queryByText('Pick the housing authority from the list, or clear the text.')).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
  }

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: [ATLANTA, DEKALB] });
  });

  it('fills the housing authorities from the property - exact names and unique spellings, in its order - and notes names off the list', async () => {
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['HADC', 'Atlanta Housing Authority', 'Nowhere Board'] }));
    renderComposer('?unitId=unit-0001');
    expect(await screen.findByRole('button', { name: 'Remove DeKalb County Housing Authority' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.getByText('Not used (not on the organization list): Nowhere Board.')).toBeInTheDocument();
    // The caption's housing authority sentence shows while the list is non-empty.
    expect(screen.getByText(/While a housing authority is selected/)).toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(lastDraftFilter()).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['DeKalb County Housing Authority', 'Atlanta Housing Authority'],
      bedroomSize: 2,
    });
  });

  it('when none of the property authorities map, says the blast is not limited by housing authority', async () => {
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['Nowhere Board'] }));
    renderComposer('?unitId=unit-0001');
    expect(
      await screen.findByText(
        'Not used (not on the organization list): Nowhere Board. This blast is not limited by housing authority.',
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(lastDraftFilter()).toEqual({ contact_type: 'tenant', bedroomSize: 2 });
  });

  it('staff edits win while the property stays: a size picked before the list lands is kept, and the authorities still fill in', async () => {
    const u = userEvent.setup();
    const list = deferred<unknown>();
    getOrgList.mockReturnValue(list.promise);
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['Atlanta Housing Authority'] }));
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByRole('button', { name: /^2-BR/ })).toHaveAttribute('aria-pressed', 'true'));
    await u.click(screen.getByRole('button', { name: /^3-BR/ }));
    await act(async () => list.resolve({ version: 1, entries: [ATLANTA, DEKALB] }));
    expect(await screen.findByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^3-BR/ })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(lastDraftFilter()).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 3,
    });
  });

  it('the same property again changes nothing; a DIFFERENT one empties both filters at once - no confirm - then its prefill fills them', async () => {
    const u = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm');
    const peach = unit({
      unitId: 'u-1',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
      accepted_authorities: ['Atlanta Housing Authority'],
    });
    const oak = unit({
      unitId: 'u-2',
      beds: 3,
      address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' },
      accepted_authorities: ['DeKalb County Housing Authority'],
    });
    getAllUnits.mockResolvedValue([peach, oak]);
    const oakLoad = deferred<UnitItem>();
    getUnit.mockImplementation((id: string) => (id === 'u-2' ? oakLoad.promise : Promise.resolve(peach)));
    renderComposer();
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    // Staff edit both of Peachtree's prefilled filters.
    await u.click(await screen.findByRole('button', { name: 'Remove Atlanta Housing Authority' }));
    await u.click(screen.getByRole('button', { name: /^4\+ BR/ }));
    // The same property again: the edits stay.
    await u.click(screen.getByRole('button', { name: 'Change property' }));
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    await screen.findByRole('combobox', { name: 'Housing authorities' });
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(screen.queryByRole('button', { name: 'Remove Atlanta Housing Authority' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^4\+ BR/ })).toHaveAttribute('aria-pressed', 'true');
    // A DIFFERENT property: both filters are empty at once, before it loads.
    await u.click(screen.getByRole('button', { name: 'Change property' }));
    await u.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    const chips = within(await screen.findByRole('group', { name: 'Voucher size' })).getAllByRole('button');
    for (const chip of chips) expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    // ...and its prefill fills them when it loads.
    await act(async () => oakLoad.resolve(oak));
    expect(await screen.findByRole('button', { name: 'Remove DeKalb County Housing Authority' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^3-BR/ })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(lastDraftFilter()).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['DeKalb County Housing Authority'],
      bedroomSize: 3,
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  // AR34/AR40 (AR23): while the prefill is unsettled NO draft is made - the
  // reach line reads pending - and the one draft made once it settles carries
  // the prefill.
  it('with a property and the filters on, Preview waits for the organization list - the draft alone does not enable it', async () => {
    const list = deferred<unknown>();
    getOrgList.mockReturnValue(list.promise);
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['Atlanta Housing Authority'] }));
    renderComposer('?unitId=unit-0001');
    // The property and its message are in, but the list has not loaded.
    await waitFor(() => expect(screen.getByLabelText('Message')).not.toHaveValue(''));
    await outlastCreateDebounce();
    expect(createBroadcast).not.toHaveBeenCalled();
    // The reach line reads pending (the spinner beside Preview is another
    // role="status", so match the reach line's own text).
    expect(screen.getByText(/Estimating reach/)).toBeInTheDocument();
    expect(preview()).toBeDisabled();
    // A prefill still LOADING settles by itself: the hint and the spinner
    // say so (FW2-1 leaves them to this case).
    expect(screen.getByText(/Sizing the audience/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    await act(async () => list.resolve({ version: 1, entries: [ATLANTA] }));
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(createBroadcast).toHaveBeenCalledTimes(1);
    expect(lastDraftFilter()).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 2,
    });
  });

  // AR44: typing proves the HOLD - with a message there would be a draft,
  // were the prefill not held. The ?unitId= entry has no other way back.
  // FW2-1: the notice alone explains it - writing a message, or clearing text
  // typed in the picker, is no remedy, so nothing beside Preview says it is.
  it('a failed property load HOLDS the prefill: no draft, Preview disabled, its notice an alert with Try again (AR44) - and no hint or spinner beside Preview (FW2-1)', async () => {
    const u = userEvent.setup();
    getUnit.mockRejectedValue(failed500());
    renderComposer('?unitId=unit-0001');
    const notice = await screen.findByText(PROPERTY_HOLD);
    expect(within(notice).getByRole('button', { name: 'Try again' })).toBeEnabled();
    expectNoPreviewHint();
    // FW2-2: the notice is announced.
    expect(screen.getByRole('alert')).toBe(notice);
    await u.type(screen.getByLabelText('Message'), 'Hello there');
    await expectHeld();
    expectNoPreviewHint();
    // Text typed in the housing authority filter (the list loaded) is no
    // remedy either while the hold stands.
    await u.type(screen.getByRole('combobox', { name: 'Housing authorities' }), 'Atl');
    expect(preview()).toBeDisabled();
    expectNoPreviewHint();
  });

  it('a failed organization list read HOLDS the prefill of a property that accepts an authority - notice and Try again; the voucher size still fills in (AR44)', async () => {
    getOrgList.mockRejectedValue(failed500());
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['Atlanta Housing Authority'] }));
    renderComposer('?unitId=unit-0001');
    const notice = await screen.findByText(LIST_HOLD);
    expect(within(notice).getByRole('button', { name: 'Try again' })).toBeEnabled();
    // The picker says its own error, as before, in an alert of its own; the
    // hold notice is the other alert (FW2-2).
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent("Couldn't load housing authorities");
    expect(alerts[1]).toBe(notice);
    // The voucher size fills in from the loaded property while the list holds.
    expect(screen.getByRole('button', { name: /^2-BR/ })).toHaveAttribute('aria-pressed', 'true');
    // The message prefill landed with the property: only the hold stops a draft.
    expect(screen.getByLabelText('Message')).not.toHaveValue('');
    await expectHeld();
  });

  // FW2-1: the list hold, too, is explained by its notice alone - typing more
  // or emptying the message is no remedy, so nothing beside Preview says it is.
  it('a failed organization list read shows no hint and no spinner beside Preview - not after typing, not with the message emptied (FW2-1)', async () => {
    const u = userEvent.setup();
    getOrgList.mockRejectedValue(failed500());
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['Atlanta Housing Authority'] }));
    renderComposer('?unitId=unit-0001');
    await screen.findByText(LIST_HOLD);
    const message = screen.getByLabelText('Message');
    await waitFor(() => expect(message).not.toHaveValue(''));
    expectNoPreviewHint();
    await u.type(message, ' See you soon.');
    await expectHeld();
    expectNoPreviewHint();
    await u.clear(message);
    expect(preview()).toBeDisabled();
    expectNoPreviewHint();
    expect(screen.getByText(LIST_HOLD)).toBeInTheDocument();
  });

  // AR34 (AR23), AR41: typing proves the HOLD - with a message there would be
  // a draft, were the prefill not waiting.
  it('an ABORTED property load is neither loaded nor failed: no notice and no Try again, and Preview keeps waiting', async () => {
    const u = userEvent.setup();
    getUnit.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    renderComposer('?unitId=unit-0001');
    await u.type(await screen.findByLabelText('Message'), 'Hello there');
    await outlastCreateDebounce();
    expect(createBroadcast).not.toHaveBeenCalled();
    expect(screen.getByText(/Estimating reach/)).toBeInTheDocument();
    expect(preview()).toBeDisabled();
    // Still loading (no notice): the hint and the spinner stay (FW2-1).
    expect(screen.getByText(/Sizing the audience/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load the property/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('Try again re-reads ONLY the property: the notice and the hold stay while it runs, and success makes exactly one draft with the prefill (AR44)', async () => {
    const u = userEvent.setup();
    const retry = deferred<UnitItem>();
    getUnit.mockRejectedValueOnce(failed500()).mockReturnValueOnce(retry.promise);
    renderComposer('?unitId=unit-0001');
    const notice = await screen.findByText(PROPERTY_HOLD);
    await u.type(screen.getByLabelText('Message'), 'Hello there');
    await u.click(within(notice).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getUnit).toHaveBeenCalledTimes(2));
    expect(getOrgList).toHaveBeenCalledTimes(1);
    // While the retry runs: the notice and the hold stay.
    expect(screen.getByText(PROPERTY_HOLD)).toBeInTheDocument();
    await expectHeld();
    await act(async () => retry.resolve(unit({ accepted_authorities: ['Atlanta Housing Authority'] })));
    expect(await screen.findByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.queryByText(PROPERTY_HOLD)).not.toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(createBroadcast).toHaveBeenCalledTimes(1);
    expect(lastDraftFilter()).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 2,
    });
  });

  it('a property Try again that fails again keeps the notice, its Try again and the hold (AR44)', async () => {
    const u = userEvent.setup();
    const retry = deferred<UnitItem>();
    getUnit.mockRejectedValueOnce(failed500()).mockReturnValueOnce(retry.promise);
    renderComposer('?unitId=unit-0001');
    const notice = await screen.findByText(PROPERTY_HOLD);
    await u.type(screen.getByLabelText('Message'), 'Hello there');
    await u.click(within(notice).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getUnit).toHaveBeenCalledTimes(2));
    await act(async () => retry.reject(failed500()));
    await expectHeld();
    expect(within(screen.getByText(PROPERTY_HOLD)).getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('Try again re-reads ONLY the organization list: the notice and the hold stay while it runs, and success makes exactly one draft with the prefill (AR44)', async () => {
    const u = userEvent.setup();
    const retry = deferred<unknown>();
    getOrgList.mockRejectedValueOnce(failed500()).mockReturnValueOnce(retry.promise);
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['Atlanta Housing Authority'] }));
    renderComposer('?unitId=unit-0001');
    const notice = await screen.findByText(LIST_HOLD);
    await u.click(within(notice).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getOrgList).toHaveBeenCalledTimes(2));
    expect(getUnit).toHaveBeenCalledTimes(1);
    // While the retry runs: the notice and the hold stay.
    expect(screen.getByText(LIST_HOLD)).toBeInTheDocument();
    await expectHeld();
    await act(async () => retry.resolve({ version: 1, entries: [ATLANTA, DEKALB] }));
    expect(await screen.findByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    expect(screen.queryByText(LIST_HOLD)).not.toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(createBroadcast).toHaveBeenCalledTimes(1);
    expect(lastDraftFilter()).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 2,
    });
  });

  it('a list Try again that fails again keeps the notice, its Try again and the hold (AR44)', async () => {
    const u = userEvent.setup();
    getOrgList.mockRejectedValue(failed500());
    getUnit.mockResolvedValue(unit({ accepted_authorities: ['Atlanta Housing Authority'] }));
    renderComposer('?unitId=unit-0001');
    await u.click(within(await screen.findByText(LIST_HOLD)).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(getOrgList).toHaveBeenCalledTimes(2));
    await expectHeld();
    expect(within(screen.getByText(LIST_HOLD)).getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('a failed list read does not hold a property that accepts NO housing authority - and holds the next one that accepts one (AR44)', async () => {
    const u = userEvent.setup();
    getOrgList.mockRejectedValue(failed500());
    const oak = unit({ unitId: 'u-2', address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' } });
    const peach = unit({
      unitId: 'u-1',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
      accepted_authorities: ['Atlanta Housing Authority'],
    });
    getAllUnits.mockResolvedValue([peach, oak]);
    getUnit.mockImplementation(async (id: string) => (id === 'u-2' ? oak : peach));
    renderComposer();
    await u.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    // Nothing to fill in from 12 Oak St: no hold and no notice.
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(screen.queryByText(/Couldn't load the organization list/)).not.toBeInTheDocument();
    expect(lastDraftFilter()).toEqual({ contact_type: 'tenant', bedroomSize: 2 });
    // 77 Peachtree St accepts one: the same failed read holds it.
    await u.click(screen.getByRole('button', { name: 'Change property' }));
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    expect(await screen.findByText(LIST_HOLD)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Message')).not.toHaveValue(''));
    await outlastCreateDebounce();
    const peachDrafts = createBroadcast.mock.calls.filter(([body]) => (body as { unitId?: string }).unitId === 'u-1');
    expect(peachDrafts).toHaveLength(0);
    expect(preview()).toBeDisabled();
  });

  // Conformance R27: a failed state belongs to the property it was for - it
  // is gone the moment another is picked, before that one even loads.
  it('a failed property load belongs to that property: picking another clears its notice at once, and the other prefills when it loads (R27)', async () => {
    const u = userEvent.setup();
    const peach = unit({
      unitId: 'u-1',
      address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
      accepted_authorities: ['DeKalb County Housing Authority'],
    });
    const oak = unit({
      unitId: 'u-2',
      address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' },
      accepted_authorities: ['Atlanta Housing Authority'],
    });
    getAllUnits.mockResolvedValue([peach, oak]);
    const oakLoad = deferred<UnitItem>();
    getUnit.mockImplementation((id: string) => (id === 'u-1' ? Promise.reject(failed500()) : oakLoad.promise));
    renderComposer();
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    expect(await screen.findByText(PROPERTY_HOLD)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Change property' }));
    await u.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    // 12 Oak St is still loading: no notice and no Try again - only the wait.
    await screen.findByRole('combobox', { name: 'Housing authorities' });
    expect(screen.queryByText(PROPERTY_HOLD)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    await act(async () => oakLoad.resolve(oak));
    expect(await screen.findByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeInTheDocument();
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(createBroadcast).toHaveBeenCalledTimes(1);
    expect(lastDraftFilter()).toEqual({
      contact_type: 'tenant',
      housing_authorities: ['Atlanta Housing Authority'],
      bedroomSize: 2,
    });
  });

  it('(PIN) a resumed draft is never gated: the list never loads, and Preview still works once a message is written', async () => {
    const u = userEvent.setup();
    getOrgList.mockReturnValue(new Promise(() => {}));
    renderComposer('?draftId=bcast_resume');
    await u.type(screen.getByLabelText('Message'), 'Hello there');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
  });

  it('(PIN) a seeds-only send is never gated: the list never loads, and Preview still works', async () => {
    getOrgList.mockReturnValue(new Promise(() => {}));
    renderComposer('?unitId=unit-0001&contactId=c-seed');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
  });
});

// matching-blast-rules D7, D8: the rules reads behind a filter draft's preview
// and reach.
describe('BroadcastComposer - tour and Not interested reads (matching-blast-rules D7, D8)', () => {
  it('a 503 audience_rules_unavailable keeps compose with the message, and Try again re-runs the preview', async () => {
    const u = userEvent.setup();
    previewBroadcast
      .mockRejectedValueOnce(
        new ApiError(503, 'audience_rules_unavailable', 'audience_rules_unavailable', {
          error: 'audience_rules_unavailable',
        }),
      )
      .mockResolvedValueOnce({
        count: 1,
        truncated: false,
        candidates: [
          {
            contactId: 'c1',
            firstName: 'Tasha',
            phone: '+14040000001',
            alreadySentThisProperty: false,
            has_consent: true,
            seeded: false,
            declinedThisProperty: false,
            checkedByDefault: true,
          },
        ],
        priorRecipientContactIds: [],
        seedContactIds: [],
        unresolvedSeedIds: [],
        declinedContactIds: [],
        tourHolds: [],
      });
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled(), {
      timeout: 4000,
    });
    await u.click(screen.getByRole('button', { name: 'Preview recipients' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      "Couldn't check tours and Not interested replies, so the recipient list can't be shown yet.",
    );
    // Still on compose, never the raw code.
    expect(screen.queryByRole('heading', { name: 'Review recipients' })).not.toBeInTheDocument();
    expect(screen.queryByText(/audience_rules_unavailable/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message')).not.toHaveValue('');
    await u.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Review recipients' })).toBeInTheDocument();
    expect(previewBroadcast).toHaveBeenCalledTimes(2);
  });

  it('(PIN) a draft whose reach could not be computed (no estimatedCount) reads "Reach estimate unavailable"', async () => {
    createBroadcast.mockResolvedValue({ broadcastId: 'draft_1', status: 'draft', truncated: false });
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled(), {
      timeout: 4000,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Reach estimate unavailable');
  });

  // AR25 (its mechanism is AR39's): the alert belongs to the draft its
  // Preview read, so a filter change takes it away - no effect clears it.
  it('after a 503, changing the voucher size removes the alert', async () => {
    const RULES_UNAVAILABLE =
      "Couldn't check tours and Not interested replies, so the recipient list can't be shown yet.";
    const u = userEvent.setup();
    previewBroadcast.mockRejectedValue(
      new ApiError(503, 'audience_rules_unavailable', 'audience_rules_unavailable', {
        error: 'audience_rules_unavailable',
      }),
    );
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled(), {
      timeout: 4000,
    });
    await u.click(screen.getByRole('button', { name: 'Preview recipients' }));
    expect(await screen.findByText(RULES_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /^3-BR/ }));
    expect(screen.queryByText(RULES_UNAVAILABLE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

// Code review R2-FE-3: the composer's audience is a real send. Text typed in
// the housing authority filter but never picked is NOT a filter (spec D7: the
// draft changes only on a pick or a clear), so Preview waits until staff pick
// a name or clear the text - an unfiltered preview never passes for a
// filtered one.
describe('BroadcastComposer - text typed in the housing authority filter', () => {
  const ATLANTA = {
    orgId: 'o-atl',
    kind: 'housing_authority',
    name: 'Atlanta Housing Authority',
    spellings: ['AHA'],
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
  const HINT = 'Pick the housing authority from the list, or clear the text.';
  const preview = (): HTMLElement => screen.getByRole('button', { name: 'Preview recipients' });
  const authority = (): HTMLElement => screen.getByRole('combobox', { name: 'Housing authorities' });
  const draftAuthorities = (): unknown[] =>
    createBroadcast.mock.calls.map(
      ([body]) => (body as { audience_filter?: { housing_authorities?: string[] } } | undefined)?.audience_filter?.housing_authorities,
    );

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: [ATLANTA] });
  });

  it('a full name typed but not picked holds Preview back and says why - a pick lets it go', async () => {
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    await u.type(authority(), 'Atlanta Housing Authority');
    await screen.findByRole('option', { name: /^Atlanta Housing Authority/ });
    expect(preview()).toBeDisabled();
    expect(screen.getByText(HINT)).toBeInTheDocument();
    expect(previewBroadcast).not.toHaveBeenCalled();
    // Typing never recreated the draft (D7): no draft carried the text.
    expect(draftAuthorities().every((a) => a === undefined)).toBe(true);
    await u.click(screen.getByRole('option', { name: /^Atlanta Housing Authority/ }));
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(draftAuthorities().at(-1)).toEqual(['Atlanta Housing Authority']);
  });

  it('clearing the text lets Preview go again - with no new draft', async () => {
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    const drafts = createBroadcast.mock.calls.length;
    await u.type(authority(), 'Atl');
    expect(preview()).toBeDisabled();
    await u.clear(authority());
    expect(preview()).toBeEnabled();
    expect(createBroadcast).toHaveBeenCalledTimes(drafts);
  });

  it('(PIN) text typed before "Change" goes with the compose step: Preview works for the next pick', async () => {
    const u = userEvent.setup();
    renderComposer();
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    await u.type(await screen.findByRole('combobox', { name: 'Housing authorities' }), 'Atl');
    await u.click(screen.getByRole('button', { name: 'Change property' }));
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    await waitFor(() => expect(preview()).toBeEnabled(), { timeout: 4000 });
    expect(authority()).toHaveValue('');
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});

// Code review R3-FE-1: a Preview pages the whole audience, so it can take
// seconds - and the candidates it returns belong to the draft it previewed.
// The audience is frozen while it loads, and a result whose draft is no
// longer the one on screen is dropped ("The audience changed - preview
// again."): Send must never post one draft's candidates to another draft.
describe('BroadcastComposer - the audience while a preview loads (code review R3-FE-1)', () => {
  const ATLANTA = {
    orgId: 'o-atl',
    kind: 'housing_authority',
    name: 'Atlanta Housing Authority',
    spellings: ['AHA'],
    createdAt: '2026-10-06T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-10-06T00:00:00.000Z',
    updatedBy: 'system',
  };
  const CHANGED = 'The audience changed - preview again.';
  // A tenant of another authority: a candidate of the unfiltered draft that an
  // Atlanta filter would never reach.
  const DEKALB_TENANT = {
    contactId: 'c-dekalb',
    firstName: 'Dana',
    phone: '+14040000009',
    alreadySentThisProperty: false,
    has_consent: true,
    seeded: false,
    declinedThisProperty: false,
    checkedByDefault: true,
  };
  const previewOf = (candidates: (typeof DEKALB_TENANT)[]): unknown => ({
    count: candidates.length,
    truncated: false,
    candidates,
    priorRecipientContactIds: [],
    seedContactIds: [],
    unresolvedSeedIds: [],
    declinedContactIds: [],
    tourHolds: [],
  });
  const previewButton = (): HTMLElement => screen.getByRole('button', { name: 'Preview recipients' });
  const authority = (): HTMLElement => screen.getByRole('combobox', { name: 'Housing authorities' });
  const reviewHeading = (): HTMLElement | null => screen.queryByRole('heading', { name: 'Review recipients' });
  const draftAuthorities = (): unknown[] =>
    createBroadcast.mock.calls.map(
      ([body]) => (body as { audience_filter?: { housing_authorities?: string[] } } | undefined)?.audience_filter?.housing_authorities,
    );

  /** The next Preview stays in flight until the test lands it. */
  function heldPreview(): { land: (result: unknown) => Promise<void> } {
    let resolve: (value: unknown) => void = () => {};
    previewBroadcast.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    return {
      land: async (result) => {
        await act(async () => resolve(result));
      },
    };
  }

  /** Outlast the composer's 600 ms create debounce: any draft a change
   *  started has been made by now. */
  async function outlastDebounce(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 800));
    });
  }

  beforeEach(() => {
    getOrgList.mockResolvedValue({ version: 1, entries: [ATLANTA] });
    createBroadcast
      .mockResolvedValueOnce({ broadcastId: 'draft_1', status: 'draft', estimatedCount: 5, truncated: false })
      .mockResolvedValue({ broadcastId: 'draft_2', status: 'draft', estimatedCount: 1, truncated: false });
  });

  it('a pick tried while the preview loads changes nothing: the review and Send stay on the previewed draft', async () => {
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(previewButton()).toBeEnabled(), { timeout: 4000 });
    const held = heldPreview();
    await u.click(previewButton());
    // Staff notice the unfiltered audience and try to pick Atlanta.
    await u.type(authority(), 'AHA');
    await u.keyboard('{ArrowDown}{Enter}');
    await held.land(previewOf([DEKALB_TENANT]));
    await outlastDebounce();
    expect(await screen.findByRole('heading', { name: 'Review recipients' })).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Send to 1 recipient' }));
    // The candidates go to the draft they were previewed from - never to a
    // draft made for another audience.
    await waitFor(() => expect(sendBroadcast).toHaveBeenCalledWith('draft_1', ['c-dekalb']));
    expect(draftAuthorities().every((a) => a === undefined)).toBe(true);
  });

  it('the filters are frozen while the preview loads - the picker, its chip and the voucher chips', async () => {
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(previewButton()).toBeEnabled(), { timeout: 4000 });
    await u.type(authority(), 'AHA');
    await u.click(await screen.findByRole('option', { name: /^Atlanta Housing Authority/ }));
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() => expect(previewButton()).toBeEnabled(), { timeout: 4000 });
    const held = heldPreview();
    await u.click(previewButton());
    expect(authority()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeDisabled();
    for (const chip of screen.getAllByRole('button', { name: /^\d\+?-BR/ })) expect(chip).toBeDisabled();
    await held.land(previewOf([DEKALB_TENANT]));
    expect(await screen.findByRole('heading', { name: 'Review recipients' })).toBeInTheDocument();
    // Back on the audience, the filters work again.
    await u.click(screen.getByRole('button', { name: /Edit audience/ }));
    expect(authority()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove Atlanta Housing Authority' })).toBeEnabled();
  });

  it('text typed while the preview loads: the frozen field takes none, so none is dropped unseen when the review opens', async () => {
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(previewButton()).toBeEnabled(), { timeout: 4000 });
    const held = heldPreview();
    await u.click(previewButton());
    await u.type(authority(), 'Atlanta Housing Authority');
    expect(authority()).toBeDisabled();
    expect(authority()).toHaveValue('');
    await held.land(previewOf([DEKALB_TENANT]));
    expect(await screen.findByRole('heading', { name: 'Review recipients' })).toBeInTheDocument();
    expect(draftAuthorities().every((a) => a === undefined)).toBe(true);
  });

  it('a message edited while the preview loads: the result is dropped - no review, no Send - and Preview reads the new draft', async () => {
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(previewButton()).toBeEnabled(), { timeout: 4000 });
    const held = heldPreview();
    await u.click(previewButton());
    // The message is not frozen; changing it makes a new draft.
    await u.type(screen.getByLabelText('Message'), ' Call us today.');
    await held.land(previewOf([DEKALB_TENANT]));
    expect(reviewHeading()).not.toBeInTheDocument();
    expect(screen.getByText(CHANGED)).toBeInTheDocument();
    // The new draft lands: the dropped result never comes back.
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() => expect(previewButton()).toBeEnabled(), { timeout: 4000 });
    expect(reviewHeading()).not.toBeInTheDocument();
    previewBroadcast.mockResolvedValueOnce(previewOf([DEKALB_TENANT]));
    await u.click(previewButton());
    expect(await screen.findByRole('heading', { name: 'Review recipients' })).toBeInTheDocument();
    expect(previewBroadcast).toHaveBeenLastCalledWith('draft_2');
    expect(screen.queryByText(CHANGED)).not.toBeInTheDocument();
    expect(sendBroadcast).not.toHaveBeenCalled();
  });

  it('a property changed while the preview loads: its result is never reviewed under the next property', async () => {
    const u = userEvent.setup();
    const oak = unit({
      unitId: 'u-2',
      address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' },
    });
    getAllUnits.mockResolvedValue([...pickableUnits, oak]);
    getUnit.mockImplementation(async (id: string) => (id === 'u-2' ? oak : pickableUnits[0]));
    renderComposer();
    await u.click(await screen.findByRole('button', { name: /77 Peachtree St/ }));
    await waitFor(() => expect(previewButton()).toBeEnabled(), { timeout: 4000 });
    const held = heldPreview();
    await u.click(previewButton());
    await u.click(screen.getByRole('button', { name: 'Change property' }));
    await u.click(await screen.findByRole('button', { name: /12 Oak St/ }));
    // 77 Peachtree's candidates land after 12 Oak St was picked.
    await held.land(previewOf([DEKALB_TENANT]));
    expect(reviewHeading()).not.toBeInTheDocument();
    expect(screen.getByText(CHANGED)).toBeInTheDocument();
    await waitFor(() => expect(createBroadcast).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(createBroadcast.mock.calls[1]?.[0]).toMatchObject({ unitId: 'u-2' });
    expect(reviewHeading()).not.toBeInTheDocument();
    expect(sendBroadcast).not.toHaveBeenCalled();
  });
});

// Code review R4-2: a change undone before its new draft is made - inside the
// debounce, or after its recreate failed - puts the screen back on the live
// draft. Nothing is pending and nothing is stale then: Preview works at once,
// with no new draft.
describe('BroadcastComposer - a change undone before its draft lands (code review R4-2)', () => {
  const previewButton = (): HTMLElement => screen.getByRole('button', { name: 'Preview recipients' });
  const message = (): HTMLElement => screen.getByRole('textbox', { name: 'Message' });

  /** Outlast the composer's 600 ms create debounce. */
  async function outlastDebounce(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 800));
    });
  }

  it('a character typed and deleted inside the debounce: Preview is enabled again, not left "Sizing the audience"', async () => {
    const u = userEvent.setup();
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(previewButton()).toBeEnabled(), { timeout: 4000 });
    await u.type(message(), 'X{Backspace}');
    await outlastDebounce();
    expect(createBroadcast).toHaveBeenCalledTimes(1);
    expect(previewButton()).toBeEnabled();
    expect(screen.queryByText(/Sizing the audience/)).not.toBeInTheDocument();
  });

  it('a change whose recreate failed, undone: the error goes and Preview is enabled again', async () => {
    const u = userEvent.setup();
    createBroadcast
      .mockResolvedValueOnce({ broadcastId: 'draft_1', status: 'draft', estimatedCount: 5, truncated: false })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderComposer('?unitId=unit-0001');
    await waitFor(() => expect(previewButton()).toBeEnabled(), { timeout: 4000 });
    await u.type(message(), 'X');
    expect(await screen.findByText(/estimate the audience/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(previewButton()).toBeDisabled();
    await u.type(message(), '{Backspace}');
    expect(previewButton()).toBeEnabled();
    expect(screen.queryByText(/estimate the audience/)).not.toBeInTheDocument();
    await outlastDebounce();
    expect(createBroadcast).toHaveBeenCalledTimes(2);
  });
});

// matching-blast-rules D9: the property picker offers only Available
// properties, on every entry that shows it (the bare Matching entry and the
// ?contactId= entry). A ?unitId= preselection (the property page's "+ Send")
// keeps its property whatever the status, with the banner and the Make
// Available dialog.
describe('BroadcastComposer - Available properties only (matching-blast-rules D9)', () => {
  const peach = unit({
    unitId: 'u-1',
    address: { line1: '77 Peachtree St', city: 'Atlanta', state: 'GA', zip: '30303' },
  });
  const oak = unit({
    unitId: 'u-2',
    status: 'on_hold',
    address: { line1: '12 Oak St', city: 'Atlanta', state: 'GA', zip: '30303' },
  });
  const elm = unit({
    unitId: 'u-3',
    status: 'setup',
    address: { line1: '5 Elm St', city: 'Atlanta', state: 'GA', zip: '30303' },
  });

  it('the bare entry lists and searches only Available properties', async () => {
    const u = userEvent.setup();
    getAllUnits.mockResolvedValue([peach, oak, elm]);
    renderComposer();
    expect(await screen.findByRole('button', { name: /77 Peachtree St/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /12 Oak St/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /5 Elm St/ })).not.toBeInTheDocument();
    // The search finds nothing that is not Available either.
    await u.type(screen.getByRole('combobox', { name: 'Property' }), 'Oak');
    expect(screen.queryByRole('option', { name: /12 Oak St/ })).not.toBeInTheDocument();
    expect(screen.getByText('No properties match that search - clear it to browse them all.')).toBeInTheDocument();
  });

  it('the ?contactId= entry (a tenant or caseworker page) lists only Available properties too', async () => {
    getAllUnits.mockResolvedValue([peach, oak, elm]);
    renderComposer('?contactId=c-seed');
    expect(await screen.findByRole('button', { name: /77 Peachtree St/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /12 Oak St/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /5 Elm St/ })).not.toBeInTheDocument();
  });

  it('with no Available property the picker says why', async () => {
    getAllUnits.mockResolvedValue([oak, elm]);
    renderComposer();
    await waitFor(() => expect(getAllUnits).toHaveBeenCalled());
    expect(
      await screen.findByText('No Available properties. A property must be Available to send.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /12 Oak St/ })).not.toBeInTheDocument();
  });

  it('(PIN) a ?unitId= preselection keeps a non-Available property, with the banner', async () => {
    getUnit.mockResolvedValue(oak);
    renderComposer('?unitId=u-2');
    expect(await screen.findByText(/flyer link won't work/)).toHaveTextContent(/This property is On hold/);
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(getAllUnits).not.toHaveBeenCalled();
  });

  // AR37, AR41: the picker's empty-state sentence follows the properties
  // read - none while it is in flight, one for a failed read, and an ABORTED
  // read (React StrictMode's first mount) is neither.
  const NONE_AVAILABLE = 'No Available properties. A property must be Available to send.';
  const READ_FAILED = "Couldn't load the properties.";
  const OLD_EMPTY = 'No properties yet - add one from the Properties page.';

  /** Let a settled read reach the composer: past every pending microtask. */
  async function flushRead(): Promise<void> {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it('while the properties are still loading the picker shows no empty-state sentence', async () => {
    getAllUnits.mockReturnValue(new Promise(() => {}));
    renderComposer();
    await screen.findByRole('combobox', { name: 'Property' });
    await waitFor(() => expect(getAllUnits).toHaveBeenCalled());
    await flushRead();
    expect(screen.queryByText(NONE_AVAILABLE)).not.toBeInTheDocument();
    expect(screen.queryByText(READ_FAILED)).not.toBeInTheDocument();
    expect(screen.queryByText(OLD_EMPTY)).not.toBeInTheDocument();
  });

  it('a failed properties read says the properties could not be loaded', async () => {
    getAllUnits.mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    renderComposer();
    expect(await screen.findByText(READ_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(NONE_AVAILABLE)).not.toBeInTheDocument();
    expect(screen.queryByText(OLD_EMPTY)).not.toBeInTheDocument();
  });

  it('an ABORTED properties read is neither loaded nor failed: no sentence', async () => {
    getAllUnits.mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));
    renderComposer();
    await screen.findByRole('combobox', { name: 'Property' });
    await waitFor(() => expect(getAllUnits).toHaveBeenCalled());
    await flushRead();
    expect(screen.queryByText(READ_FAILED)).not.toBeInTheDocument();
    expect(screen.queryByText(NONE_AVAILABLE)).not.toBeInTheDocument();
    expect(screen.queryByText(OLD_EMPTY)).not.toBeInTheDocument();
  });
});
