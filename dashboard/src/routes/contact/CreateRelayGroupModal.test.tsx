// CreateRelayGroupModal - the three-state standalone relay-group create flow
// (picking -> confirming -> connecting) started from the contact file's
// "Relay groups" card. Every rule pinned here came from a design review:
// one modal at a time, member state that survives a Cancel, names built from
// first/last ONLY (never the search field's phone-fallback display name), a
// failed preview that never opens the confirm dialog, and a `connecting` create
// that says the intro has NOT gone out instead of navigating away.
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useCallback, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ApiError, type Contact, type RosterPreview } from '../../api/index.js';

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

/** The AMBIGUOUS-failure panel. Byte-exact copy of the shipped string: it is the
 *  only thing standing between a dropped connection and a second purchased pool
 *  number, so a drifted sentence is a real regression. */
const AMBIGUOUS_NOTICE =
  'The connection dropped before the server answered, so the group may or may not have been created. Check the Relay groups card on this page before trying again - creating it again could text everyone twice.';

function Probe(): React.JSX.Element {
  return <output data-testid="loc">{useLocation().pathname}</output>;
}

/** Stands in for ContactDetail: it really UNMOUNTS the modal on onClose, so the
 *  navigate-and-close path is exercised the way the page runs it. */
function Host({
  contact,
  candidates,
  onClosed,
  onCreated,
  onAmbiguous,
}: {
  contact: Contact;
  candidates: Contact[];
  onClosed: () => void;
  onCreated: (c: unknown) => void;
  onAmbiguous: () => void;
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
      onCreated={onCreated}
      onAmbiguousCreate={onAmbiguous}
    />
  );
}

function renderIt(opts: { contact?: Contact; candidates?: Contact[] } = {}) {
  const onClosed = vi.fn();
  const onCreated = vi.fn();
  const onAmbiguous = vi.fn();
  const { unmount } = render(
    <MemoryRouter initialEntries={['/contacts/T1']}>
      <Host
        contact={opts.contact ?? TENANT}
        candidates={opts.candidates ?? ALL}
        onClosed={onClosed}
        onCreated={onCreated}
        onAmbiguous={onAmbiguous}
      />
      <Probe />
    </MemoryRouter>,
  );
  return { onClosed, onCreated, onAmbiguous, unmount, user: userEvent.setup() };
}

/** Arm a preview that never settles on its own, so the flow stays `busy` for as
 *  long as the test needs. Returns the resolver. */
function pendingPreview(): (p: RosterPreview) => void {
  let resolve!: (p: RosterPreview) => void;
  previewRelayGroup.mockReturnValue(
    new Promise<RosterPreview>((r) => {
      resolve = r;
    }),
  );
  return resolve;
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

describe('CreateRelayGroupModal - the preview round trip is HELD', () => {
  // The members array is snapshotted into startPreview's closure and installed
  // on resolve, so an ADD made mid-flight would show on screen and be absent
  // from the previewed group. The LIST is therefore frozen for the duration.
  //
  // The FLOW is not. The preview provisions nothing, so an operator who no
  // longer wants this group must be able to leave while it is in flight - see
  // the "can always be abandoned" block below.

  it('freezes the member search while the preview is in flight', async () => {
    pendingPreview();
    const { user } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    expect(screen.getByRole('combobox', { name: 'Add member' })).toBeDisabled();
    // The matching affordance was already frozen - this is the pair.
    expect(screen.getByRole('button', { name: 'Remove Marcus Bell' })).toBeDisabled();
  });

  it('an add attempted mid-preview cannot change the member list', async () => {
    const resolve = pendingPreview();
    const { user } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.type(screen.getByRole('combobox', { name: 'Add member' }), 'Renee');
    expect(screen.queryByRole('option')).toBeNull();
    expect(
      within(screen.getByRole('list', { name: 'Members' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    // ...and the confirm dialog therefore lists exactly what was posted.
    resolve(PREVIEW);
    await screen.findByRole('button', { name: 'Open relay group' });
    expect(sentMembers(previewRelayGroup)).toHaveLength(2);
  });

  it('a re-render of the PAGE BEHIND the modal does not interrupt typing', async () => {
    // Modal keys its Escape/focus effect on the callback it receives: a fresh
    // identity tears the effect down (returning focus to the previously focused
    // element) and re-runs it (focusing the dialog), so everything typed after
    // that goes nowhere. The dismissal guard this modal builds is memoized for
    // that reason - and that only holds if the CALLER's onClose is stable too,
    // which is why ContactDetail memoizes the one it passes. The page re-renders
    // on every message.persisted / conversation.updated / scheduled.updated tick,
    // and the operator is on it because the contact is texting them.
    // TODO(modal-onclose-refocus-trap): the class fix belongs in Modal itself.
    function StableHost(): React.JSX.Element {
      const [tick, setTick] = useState(0);
      const onClose = useCallback(() => undefined, []);
      return (
        <>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            bump the page
          </button>
          <output data-testid="tick">{tick}</output>
          <CreateRelayGroupModal contact={TENANT} candidates={ALL} onClose={onClose} />
        </>
      );
    }
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/contacts/T1']}>
        <StableHost />
      </MemoryRouter>,
    );
    const search = screen.getByRole('combobox', { name: 'Add member' });
    await user.type(search, 'Mar');
    expect(document.activeElement).toBe(search);

    // fireEvent, not user.click: a real click would move focus to the button and
    // the follow-up typing would re-focus the field, hiding the very thing this
    // test is about. This is a re-render arriving from OUTSIDE the dialog.
    fireEvent.click(screen.getByRole('button', { name: 'bump the page' }));
    expect(screen.getByTestId('tick')).toHaveTextContent('1');

    await user.keyboard('cus');
    expect(search).toHaveValue('Marcus');
    expect(document.activeElement).toBe(search);
  });

  it('aborts an in-flight preview when the flow unmounts', async () => {
    pendingPreview();
    const { user, unmount } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    const signal = previewRelayGroup.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe('CreateRelayGroupModal - the PICKER can always be abandoned', () => {
  // DELIBERATE REVERSAL of the earlier busy-guard on this modal. The preview is
  // a PURE READ: it provisions nothing, buys nothing and texts nobody, so a slow
  // or hung one must never trap the operator in a dialog they have to reload the
  // page to leave. Every dismissal path works while it is in flight, and each
  // one ABORTS the request on its way out.
  //
  // The CONFIRM dialog's own guard is untouched and stays untouched - that one
  // covers a round trip that buys a pool number.

  it('Escape mid-preview leaves the flow and aborts the request', async () => {
    pendingPreview();
    const { user, onClosed } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    const signal = previewRelayGroup.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await user.keyboard('{Escape}');
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel is live mid-preview - it closes the flow and aborts the request', async () => {
    pendingPreview();
    const { user, onClosed } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();
    const signal = previewRelayGroup.mock.calls[0]![1] as AbortSignal;
    await user.click(cancel);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the header X is the same door', async () => {
    pendingPreview();
    const { user, onClosed } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    const signal = previewRelayGroup.mock.calls[0]![1] as AbortSignal;
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
  });

  it('the member LIST is still frozen while the preview is in flight', async () => {
    // Leaving is allowed; EDITING is not. The two halves are independent.
    pendingPreview();
    const { user } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    expect(screen.getByRole('combobox', { name: 'Add member' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Marcus Bell' })).toBeDisabled();
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
    // The tag rides the CREATE only, trimmed; the preview never carries one -
    // its second argument is the abort signal, nothing else.
    expect(createRelayGroup.mock.calls[0]![1]).toBe('Maple St');
    expect(previewRelayGroup.mock.calls[0]!).toHaveLength(2);
    expect(previewRelayGroup.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
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

  it('keeps the confirm dialog OPEN when the SERVER refuses the create', async () => {
    // A refusal the server SENT: it has a status, so nothing was created and the
    // dialog's re-armed confirm is the right affordance. A rejection with no
    // answer behind it is a different story - see the AMBIGUOUS block below.
    createRelayGroup.mockRejectedValue(new ApiError(400, 'roster_too_thin', 'roster_too_thin'));
    const { user } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/please try again/);
    expect(screen.getByRole('heading', { name: 'Open the relay group?' })).toBeInTheDocument();
    expect(screen.getByTestId('loc')).toHaveTextContent('/contacts/T1');
  });
});

describe('CreateRelayGroupModal - the CREATE round trip is HELD too', () => {
  // The preview round trip above loses only a list. THIS one buys a pool number,
  // opens a conversation and texts everyone on it, and `POST /api/relay-groups`
  // has no idempotency key - so a dismissal that hands the picker back mid-flight
  // is a second purchased number for the same pair, not a lost list.

  /** Arm a create that never settles on its own. Returns the resolver. */
  function pendingCreate(): (v: unknown) => void {
    let resolve!: (v: unknown) => void;
    createRelayGroup.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    return resolve;
  }

  it('Escape and the X cannot dismiss the confirm dialog while the create is on the wire', async () => {
    const resolve = pendingCreate();
    const { user, onClosed } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    expect(createRelayGroup).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    // The confirm dialog is still the one thing on screen: there is no picker to
    // press "Create group" in, so a second create is not even offered.
    expect(screen.getByRole('heading', { name: 'Open the relay group?' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Create a relay group' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create group' })).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();

    // The header X is the same door (as is the backdrop - one guard covers all).
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('heading', { name: 'Open the relay group?' })).toBeInTheDocument();
    expect(onClosed).not.toHaveBeenCalled();

    // The one create that was started is the only one there ever was.
    resolve({
      conversation: { conversationId: 'conv-9', type: 'relay_group', status: 'connecting' },
    });
    expect(await screen.findByText(CONNECTING_NOTICE)).toBeInTheDocument();
    expect(createRelayGroup).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the flow again once the create has SETTLED', async () => {
    // The guard is the round trip, not the flow: the connecting panel is a
    // result an operator must be able to dismiss.
    createRelayGroup.mockResolvedValue({
      conversation: { conversationId: 'conv-9', type: 'relay_group', status: 'connecting' },
    });
    const { user, onClosed } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    await screen.findByText(CONNECTING_NOTICE);

    await user.keyboard('{Escape}');
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a create whose onCreated callback THROWS still lands on the result panel', async () => {
    // onCreated fires inside the promise RosterConfirmDialog awaits, so a
    // throwing page callback would be caught by the dialog's own .catch and
    // rendered as "please try again" over a group that WAS created - inviting
    // exactly the second create this flow must never make. The group exists
    // either way; refreshing the page behind it is not this flow's contract.
    createRelayGroup.mockResolvedValue({
      conversation: { conversationId: 'conv-9', type: 'relay_group', status: 'connecting' },
    });
    const onCreated = vi.fn(() => {
      throw new Error('the page blew up refreshing its card');
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/contacts/T1']}>
        <CreateRelayGroupModal
          contact={TENANT}
          candidates={ALL}
          onClose={() => undefined}
          onCreated={onCreated}
        />
      </MemoryRouter>,
    );
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));

    expect(await screen.findByText(CONNECTING_NOTICE)).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
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

  it('reports a CONNECTING create through onCreated, before the panel renders', async () => {
    // The connecting branch deliberately does NOT navigate, so the page it
    // leaves the operator standing on is the one holding a Relay groups card
    // that fetched once, on mount. Without this callback the card still reads
    // "No relay groups yet." and a retry buys a second Twilio number.
    createRelayGroup.mockResolvedValue({
      conversation: { conversationId: 'conv-9', type: 'relay_group', status: 'connecting' },
    });
    const { user, onCreated } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    await screen.findByText(CONNECTING_NOTICE);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-9', status: 'connecting' }),
    );
  });

  it('reports an OPEN create through onCreated too - the branch is downstream', async () => {
    const { user, onCreated } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-9', status: 'open' }),
    );
  });

  it('a REFUSED create reports nothing - onCreated means a group exists', async () => {
    createRelayGroup.mockRejectedValue(new ApiError(400, 'roster_too_thin', 'roster_too_thin'));
    const { user, onCreated } = renderIt();
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/please try again/);
    expect(onCreated).not.toHaveBeenCalled();
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

describe('CreateRelayGroupModal - an AMBIGUOUS create is never re-armed', () => {
  // A create fails in TWO different worlds and the retry affordance must differ:
  //
  //   THE SERVER ANSWERED (ApiError with a real status) - it refused, nothing
  //     was created, and confirming again is exactly right. The dialog's own
  //     inline-error path owns that, so the rejection PROPAGATES untouched.
  //   NOBODY ANSWERED (a dropped connection, a timeout, ApiError status 0) - the
  //     request may have COMMITTED before the wire died. `POST /api/relay-groups`
  //     has no idempotency key and the standalone route has no owner row to 409
  //     against, so a retry mints a SECOND group, buys a SECOND pool number and
  //     texts everyone a second intro. There is no affordance that can retry
  //     safely, so the flow offers none: it says what happened and stops.

  /** A refusal the SERVER sent: a status, and a renderable message in the body. */
  function serverRefusal(): ApiError {
    return new ApiError(503, 'relay_provisioning_disabled', 'relay_provisioning_disabled', {
      error: 'relay_provisioning_disabled',
      message: 'Live number provisioning is off - no number could be bought.',
    });
  }

  async function createWith(
    reason: unknown,
  ): Promise<ReturnType<typeof renderIt>> {
    createRelayGroup.mockRejectedValue(reason);
    const handles = renderIt();
    await pick(handles.user, 'Marcus', /Marcus Bell/);
    await handles.user.click(screen.getByRole('button', { name: 'Create group' }));
    await handles.user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    return handles;
  }

  it('a SERVER refusal keeps the confirm dialog open and re-armed - nothing was created', async () => {
    const { onCreated, onAmbiguous } = await createWith(serverRefusal());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Live number provisioning is off - no number could be bought.',
    );
    // Still the confirm dialog, still confirming: this retry is the safe one.
    expect(screen.getByRole('heading', { name: 'Open the relay group?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open relay group' })).toBeEnabled();
    expect(screen.queryByText(AMBIGUOUS_NOTICE)).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onAmbiguous).not.toHaveBeenCalled();
  });

  it('a DROPPED CONNECTION lands on the maybe-created panel with no way to retry', async () => {
    const { user, onClosed, onCreated, onAmbiguous } = await createWith(
      new TypeError('Failed to fetch'),
    );
    expect(await screen.findByText(AMBIGUOUS_NOTICE)).toBeInTheDocument();
    // The confirm dialog is GONE and the picker did not come back, so neither
    // affordance that starts a create exists on screen.
    expect(screen.queryByRole('heading', { name: 'Open the relay group?' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open relay group' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create group' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Add member' })).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    // The one create that was started is the only one there ever was, and the
    // flow stayed on the page whose card the operator has to go and read.
    expect(createRelayGroup).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('loc')).toHaveTextContent('/contacts/T1');
    // The page is told to refresh - a group that DID land must be on the card by
    // the time the operator looks. `onCreated` is not: it means a group exists.
    expect(onAmbiguous).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    // Close is the only action, and it really closes.
    const closers = screen.getAllByRole('button', { name: 'Close' });
    await user.click(closers[closers.length - 1]!);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a NETWORK-ERROR ApiError is ambiguous too - status 0 means nobody answered', async () => {
    // The transport wraps a failed fetch as `ApiError(0, 'network_error')`
    // (client.ts), so "is it an ApiError" cannot be the question - "did the
    // SERVER answer" is, and status 0 is documented as no answer at all. A
    // status-only check here would re-arm the create on the single most likely
    // way a commit-then-drop actually happens.
    const { onAmbiguous } = await createWith(
      new ApiError(0, 'network_error', 'Network request failed'),
    );
    expect(await screen.findByText(AMBIGUOUS_NOTICE)).toBeInTheDocument();
    expect(onAmbiguous).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Open relay group' })).toBeNull();
  });

  it('works with NO onAmbiguousCreate wired at all', async () => {
    createRelayGroup.mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/contacts/T1']}>
        <CreateRelayGroupModal contact={TENANT} candidates={ALL} onClose={() => undefined} />
      </MemoryRouter>,
    );
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    expect(await screen.findByText(AMBIGUOUS_NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an onAmbiguousCreate that THROWS still lands on the panel', async () => {
    // Same reasoning as onCreated: this call sits inside the promise the confirm
    // dialog awaits, so a throwing page callback would be rendered as "please
    // try again" over a group that may well exist.
    createRelayGroup.mockRejectedValue(new TypeError('Failed to fetch'));
    const onAmbiguousCreate = vi.fn(() => {
      throw new Error('the page blew up refreshing its card');
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/contacts/T1']}>
        <CreateRelayGroupModal
          contact={TENANT}
          candidates={ALL}
          onClose={() => undefined}
          onAmbiguousCreate={onAmbiguousCreate}
        />
      </MemoryRouter>,
    );
    await pick(user, 'Marcus', /Marcus Bell/);
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    await user.click(await screen.findByRole('button', { name: 'Open relay group' }));
    expect(await screen.findByText(AMBIGUOUS_NOTICE)).toBeInTheDocument();
    expect(onAmbiguousCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
