// CreateRelayGroupModal - the three-state standalone relay-group create flow
// (picking -> confirming -> connecting) started from the contact file's
// "Relay groups" card. Every rule pinned here came from a design review:
// one modal at a time, member state that survives a Cancel, names built from
// first/last ONLY (never the search field's phone-fallback display name), a
// failed preview that never opens the confirm dialog, and a `connecting` create
// that says the intro has NOT gone out instead of navigating away.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { Contact, RosterPreview } from '../../api/index.js';

const previewRelayGroup = vi.fn();
const createRelayGroup = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    previewRelayGroup: (...a: unknown[]) => previewRelayGroup(...a),
    createRelayGroup: (...a: unknown[]) => createRelayGroup(...a),
  };
});

import { CreateRelayGroupModal } from './CreateRelayGroupModal.js';

const TENANT: Contact = {
  contactId: 'T1',
  type: 'tenant',
  firstName: 'Tasha',
  lastName: 'Nguyen',
  phone: '+14040100007',
};
const LANDLORD: Contact = {
  contactId: 'L1',
  type: 'landlord',
  firstName: 'Marcus',
  lastName: 'Bell',
  phone: '+14042220190',
};
/** A partner contact - only visible as a candidate because this branch widened
 *  TYPES_FOR.all. This fixture is the widening's ONLY behavioral coverage. */
const PARTNER: Contact = {
  contactId: 'P1',
  type: 'partner',
  firstName: 'Renee',
  lastName: 'Carter',
  phone: '+14045550143',
};
/** No first or last name: the picker must render "Unnamed number" and send NO
 *  name, never the search field's formatted-phone display value. */
const NAMELESS: Contact = { contactId: 'N1', type: 'unknown', phone: '+14040100002' };
const PHONELESS: Contact = {
  contactId: 'X1',
  type: 'tenant',
  firstName: 'Pat',
  lastName: 'Phoneless',
};
/** Shares LANDLORD's number - create would collapse the pair, so the picker
 *  must drop this candidate once Marcus is added. */
const TWIN: Contact = {
  contactId: 'W1',
  type: 'unknown',
  firstName: 'Twin',
  lastName: 'Number',
  phone: '+14042220190',
};
/** Shares the SEEDED contact's number: never a candidate at all. */
const SEED_TWIN: Contact = {
  contactId: 'S1',
  type: 'unknown',
  firstName: 'Seed',
  lastName: 'Twin',
  phone: '+14040100007',
};

const ALL: Contact[] = [LANDLORD, PARTNER, NAMELESS, PHONELESS, TWIN, SEED_TWIN];

const PREVIEW: RosterPreview = {
  body: 'You are connected on this number. Reply STOP to opt out.',
  recipients: [
    { name: 'Tasha Nguyen', reachability: 'reachable' },
    { name: 'Marcus Bell', reachability: 'reachable' },
  ],
  recipientCount: 2,
  deferred: false,
};

const CONNECTING_NOTICE =
  'This group is still getting its number. The intro text has not been sent yet; it goes out once the number is ready.';

function Probe(): React.JSX.Element {
  return <output data-testid="loc">{useLocation().pathname}</output>;
}

/** Stands in for ContactDetail: it really UNMOUNTS the modal on onClose, so the
 *  navigate-and-close path is exercised the way the page runs it. */
function Host({
  contact,
  candidates,
  onClosed,
}: {
  contact: Contact;
  candidates: Contact[];
  onClosed: () => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <CreateRelayGroupModal
      contact={contact}
      candidates={candidates}
      onClose={() => {
        onClosed();
        setOpen(false);
      }}
    />
  );
}

function renderIt(opts: { contact?: Contact; candidates?: Contact[] } = {}) {
  const onClosed = vi.fn();
  render(
    <MemoryRouter initialEntries={['/contacts/T1']}>
      <Host contact={opts.contact ?? TENANT} candidates={opts.candidates ?? ALL} onClosed={onClosed} />
      <Probe />
    </MemoryRouter>,
  );
  return { onClosed, user: userEvent.setup() };
}

/** Type a query and COMMIT the matching candidate (the only way to add). */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  query: string,
  optionName: RegExp,
): Promise<void> {
  await user.type(screen.getByRole('combobox', { name: 'Add member' }), query);
  await user.click(screen.getByRole('option', { name: optionName }));
}

/** The members array as it reached one of the two calls. */
function sentMembers(mock: typeof previewRelayGroup): Record<string, unknown>[] {
  return mock.mock.calls[0]![0] as Record<string, unknown>[];
}

beforeEach(() => {
  vi.resetAllMocks();
  previewRelayGroup.mockResolvedValue(PREVIEW);
  createRelayGroup.mockResolvedValue({
    conversation: { conversationId: 'conv-9', type: 'relay_group', status: 'open' },
  });
});

describe('CreateRelayGroupModal - the picker', () => {
  it('seeds the contact as a LOCKED row that cannot be removed', () => {
    renderIt();
    const members = within(screen.getByRole('list', { name: 'Members' }));
    expect(members.getByText('Tasha Nguyen')).toBeInTheDocument();
    expect(members.queryByRole('button', { name: /Remove Tasha Nguyen/ })).toBeNull();
  });

  it('names the picker modal and its fields exactly as the e2e contract expects', () => {
    renderIt();
    expect(screen.getByRole('heading', { name: 'Create a relay group' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Add member' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name (optional)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create group' })).toBeInTheDocument();
  });

  it('disables Create group below TWO rows and enables it once a member is added', async () => {
    const { user } = renderIt();
    expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();
    await pick(user, 'Marcus', /Marcus Bell/);
    expect(screen.getByRole('button', { name: 'Create group' })).toBeEnabled();
  });

  it('refuses uncommitted free text - typing adds nobody', async () => {
    const { user } = renderIt();
    await user.type(screen.getByRole('combobox', { name: 'Add member' }), 'Marcus');
    const members = within(screen.getByRole('list', { name: 'Members' }));
    expect(members.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();
  });

  it('a PARTNER contact is pickable and lands in the posted members array', async () => {
    // The partner widening (TYPES_FOR.all) has no e2e coverage by design - this
    // is the ONE test that proves a partner can really be put on a relay group.
    const { user } = renderIt();
    await pick(user, 'Renee', /Renee Carter/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await screen.findByRole('button', { name: 'Open relay group' });
    expect(sentMembers(previewRelayGroup)).toContainEqual({
      phone: '+14045550143',
      contactId: 'P1',
      name: 'Renee Carter',
    });
  });

  it('a seeded contact with NO resolvable phone explains why, and Create stays disabled', async () => {
    const { user } = renderIt({
      contact: { contactId: 'T9', type: 'tenant', firstName: 'Nora', lastName: 'Nophone' },
    });
    expect(screen.getByText('no mobile number - cannot start a relay group')).toBeInTheDocument();
    // The rest of the picker still renders - the modal is the only place the
    // reason is explained, so it must not collapse to an empty dialog.
    expect(screen.getByRole('combobox', { name: 'Add member' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name (optional)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();
    await pick(user, 'Marcus', /Marcus Bell/);
    expect(screen.getByRole('button', { name: 'Create group' })).toBeDisabled();
  });

  it('sends NO name for a nameless pick and renders the dialog string "Unnamed number"', async () => {
    const { user } = renderIt();
    await pick(user, '4040100002', /010-0002/);
    const members = within(screen.getByRole('list', { name: 'Members' }));
    expect(members.getByText('Unnamed number')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await screen.findByRole('button', { name: 'Open relay group' });
    const sent = sentMembers(previewRelayGroup);
    expect(sent[1]).toEqual({ phone: '+14040100002', contactId: 'N1' });
    expect('name' in sent[1]!).toBe(false);
  });

  it('filters candidates that are already added, phone-less, or share a phone', async () => {
    const { user } = renderIt();
    // Phone-less: never offered, however you spell the query.
    await user.type(screen.getByRole('combobox', { name: 'Add member' }), 'Phoneless');
    expect(screen.queryByRole('option')).toBeNull();
    await user.clear(screen.getByRole('combobox', { name: 'Add member' }));
    // Shares the SEEDED contact's number: dropped before anything is added.
    await user.type(screen.getByRole('combobox', { name: 'Add member' }), 'Seed Twin');
    expect(screen.queryByRole('option')).toBeNull();
    await user.clear(screen.getByRole('combobox', { name: 'Add member' }));
    await pick(user, 'Marcus', /Marcus Bell/);
    // Already added.
    await user.type(screen.getByRole('combobox', { name: 'Add member' }), 'Marcus');
    expect(screen.queryByRole('option')).toBeNull();
    await user.clear(screen.getByRole('combobox', { name: 'Add member' }));
    // Shares the added member's number - create would collapse them.
    await user.type(screen.getByRole('combobox', { name: 'Add member' }), 'Twin Number');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('shows a failed preview IN THE PICKER and never opens the confirm dialog', async () => {
    previewRelayGroup.mockRejectedValue(new Error('preview blew up'));
    const { user } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/please try again/);
    expect(screen.queryByRole('button', { name: 'Open relay group' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Add member' })).toBeInTheDocument();
    expect(createRelayGroup).not.toHaveBeenCalled();
  });
});

describe('CreateRelayGroupModal - the confirm step', () => {
  it('previews first, then mounts the shared dialog with the standalone props', async () => {
    const { user } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    expect(await screen.findByRole('heading', { name: 'Open the relay group?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open relay group' })).toBeInTheDocument();
    expect(screen.getByText(PREVIEW.body)).toBeInTheDocument();
    expect(createRelayGroup).not.toHaveBeenCalled();
  });

  it('mounts exactly ONE modal per state - the picker unmounts while confirming', async () => {
    const { user } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await screen.findByRole('button', { name: 'Open relay group' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('combobox', { name: 'Add member' })).toBeNull();
  });

  it('posts the IDENTICAL members array to the preview and the create', async () => {
    const { user } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.type(screen.getByLabelText('Name (optional)'), '  Maple St  ');
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    await vi.waitFor(() => expect(createRelayGroup).toHaveBeenCalled());
    expect(createRelayGroup.mock.calls[0]![0]).toBe(previewRelayGroup.mock.calls[0]![0]);
    // The tag rides the CREATE only, trimmed; the preview never carries one.
    expect(createRelayGroup.mock.calls[0]![1]).toBe('Maple St');
    expect(previewRelayGroup.mock.calls[0]!).toHaveLength(1);
  });

  it('omits an empty tag entirely', async () => {
    const { user } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    await vi.waitFor(() => expect(createRelayGroup).toHaveBeenCalled());
    expect(createRelayGroup.mock.calls[0]![1]).toBeUndefined();
  });

  it('Cancel from the confirm step restores the picker WITH the selection intact', async () => {
    const { user, onClosed } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    const members = within(await screen.findByRole('list', { name: 'Members' }));
    expect(members.getByText('Tasha Nguyen')).toBeInTheDocument();
    expect(members.getByText('Marcus Bell')).toBeInTheDocument();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('Escape from the confirm step returns to the picker, not out of the flow', async () => {
    // Modal registers a DOCUMENT-level Escape handler with no propagation
    // guard, so two stacked modals would both close on one keypress and discard
    // the member list. Only ever one is mounted.
    const { user, onClosed } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await screen.findByRole('button', { name: 'Open relay group' });
    await user.keyboard('{Escape}');
    const members = within(await screen.findByRole('list', { name: 'Members' }));
    expect(members.getByText('Marcus Bell')).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('keeps the confirm dialog OPEN when the create fails', async () => {
    createRelayGroup.mockRejectedValue(new Error('nope'));
    const { user } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/please try again/);
    expect(screen.getByRole('heading', { name: 'Open the relay group?' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('/contacts/T1');
  });
});

describe('CreateRelayGroupModal - the create outcome', () => {
  it('a CONNECTING create says the intro has not been sent and does NOT navigate', async () => {
    createRelayGroup.mockResolvedValue({
      conversation: { conversationId: 'conv-9', type: 'relay_group', status: 'connecting' },
    });
    const { user, onClosed } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    expect(await screen.findByText(CONNECTING_NOTICE)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the group' })).toHaveAttribute(
      'href',
      '/conversations/conv-9',
    );
    expect(screen.getByTestId('loc')).toHaveTextContent('/contacts/T1');
    // The confirm dialog unmounted; exactly one modal is up, and the flow did
    // not close itself out from under the notice.
    expect(screen.queryByRole('button', { name: 'Open relay group' })).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('an OPEN create navigates to the conversation and shows no notice', async () => {
    const { user, onClosed } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    await vi.waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent('/conversations/conv-9'),
    );
    expect(screen.queryByText(CONNECTING_NOTICE)).toBeNull();
    expect(onClosed).toHaveBeenCalled();
  });

  it('the connecting panel still closes on its own Close affordance', async () => {
    createRelayGroup.mockResolvedValue({
      conversation: { conversationId: 'conv-9', type: 'relay_group', status: 'connecting' },
    });
    const { user, onClosed } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    await screen.findByText(CONNECTING_NOTICE);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClosed).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
