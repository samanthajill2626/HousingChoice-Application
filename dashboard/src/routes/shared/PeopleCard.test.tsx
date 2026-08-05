// PeopleCard component tests - the READ-ONLY roster card both hubs render
// (contact-rosters spec 6.2, plan Task 8). One assertion per row state:
//   - member rows: name links to the contact, role subtle on the right, NO phones
//   - bare-phone rows (last 4 only, never a link) and removed-contact rows
//   - the muted reachability lines and the shares-a-number line
//   - the UNAVAILABLE state, which must NEVER render a default roster in its place
//   - the customized note + the DISABLED reset placeholder when a thread exists
//   - the tenant-off-the-roster note (D11) and the caseworker hint
//   - the disabled-open-group reason (and its absence once a thread exists)
//   - the hub-owned Property / provenance rows, which stay BELOW the divider
// Edit mode, the confirm dialogs and the live [Open group text] rewiring are
// Task 11 - nothing here may assume them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, RosterMemberView, RosterPreview, RosterView } from '../../api/index.js';

// Edit mode WRITES. Mock the barrel so every routing rule (plan vs live) is
// asserted on the exact client fn that fired - the raw relay member fns are
// mocked too, purely so a test can prove the card NEVER reaches them (A4).
const addTourRosterMember = vi.fn();
const removeTourRosterMember = vi.fn();
const resetTourRoster = vi.fn();
const addTourRosterLiveMember = vi.fn();
const removeTourRosterLiveMember = vi.fn();
const previewTourRosterAdd = vi.fn();
const addConversationMember = vi.fn();
const removeConversationMember = vi.fn();
const getContacts = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    addTourRosterMember: (...a: unknown[]) => addTourRosterMember(...a),
    removeTourRosterMember: (...a: unknown[]) => removeTourRosterMember(...a),
    resetTourRoster: (...a: unknown[]) => resetTourRoster(...a),
    addTourRosterLiveMember: (...a: unknown[]) => addTourRosterLiveMember(...a),
    removeTourRosterLiveMember: (...a: unknown[]) => removeTourRosterLiveMember(...a),
    previewTourRosterAdd: (...a: unknown[]) => previewTourRosterAdd(...a),
    addConversationMember: (...a: unknown[]) => addConversationMember(...a),
    removeConversationMember: (...a: unknown[]) => removeConversationMember(...a),
    getContacts: (...a: unknown[]) => getContacts(...a),
  };
});

import { PeopleCard, type PeopleCardProps } from './PeopleCard.js';
import type { RosterSuggestion } from './rosterPeople.js';

function member(over: Partial<RosterMemberView> & { memberKey: string }): RosterMemberView {
  return { role: 'other', reachability: 'reachable', ...over };
}

function view(over: Partial<RosterView> = {}): RosterView {
  return {
    source: 'default',
    members: [
      member({ memberKey: 'c-t', contactId: 'c-t', name: 'Tasha Nguyen', role: 'tenant' }),
      member({ memberKey: 'c-pm', contactId: 'c-pm', name: 'Alicia Grant', role: 'pm' }),
    ],
    customized: false,
    tenantOnRoster: true,
    canOpenGroup: true,
    threadExists: false,
    ...over,
  };
}

function renderCard(over: Partial<PeopleCardProps> = {}): {
  onRetry: ReturnType<typeof vi.fn>;
} {
  const onRetry = vi.fn();
  const props: PeopleCardProps = {
    scope: 'tour',
    status: 'ready',
    roster: view(),
    onRetry,
    ...over,
  };
  render(
    <MemoryRouter>
      <PeopleCard {...props} />
    </MemoryRouter>,
  );
  return { onRetry };
}

beforeEach(() => {
  vi.clearAllMocks();
  getContacts.mockResolvedValue({ contacts: [], nextCursor: null });
});

/** The rendered roster rows, in payload order. */
function rosterRows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Roster' })).getAllByRole('listitem');
}

describe('PeopleCard - member rows', () => {
  it('links each contact-backed member by name and puts the role subtle on the right', () => {
    renderCard();
    const rows = rosterRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole('link', { name: 'Tasha Nguyen' })).toHaveAttribute(
      'href',
      '/contacts/c-t',
    );
    expect(within(rows[0]!).getByText('tenant')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('link', { name: 'Alicia Grant' })).toHaveAttribute(
      'href',
      '/contacts/c-pm',
    );
    expect(within(rows[1]!).getByText('PM')).toBeInTheDocument();
  });

  it('never renders a phone number on a row (spec 6.2)', () => {
    renderCard({
      roster: view({
        members: [
          member({
            memberKey: 'c-t',
            contactId: 'c-t',
            name: 'Tasha Nguyen',
            role: 'tenant',
            phoneLast4: '0111',
          }),
        ],
      }),
    });
    expect(screen.queryByText(/\(\d{3}\) \d{3}-\d{4}/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\+1\d{10}/)).not.toBeInTheDocument();
  });

  it('renders a BARE-PHONE member by its last 4 and never as a link', () => {
    renderCard({
      roster: view({
        source: 'participants',
        threadExists: true,
        members: [
          member({ memberKey: 'c-t', contactId: 'c-t', name: 'Tasha Nguyen', role: 'tenant' }),
          member({ memberKey: 'phone:+14045550199', phoneLast4: '0199', role: 'added' }),
        ],
      }),
    });
    const bare = rosterRows()[1]!;
    expect(within(bare).getByText(/ending 0199/)).toBeInTheDocument();
    expect(within(bare).queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders a REMOVED contact as a removed row, not a link to a dead record', () => {
    renderCard({
      roster: view({
        source: 'participants',
        threadExists: true,
        members: [
          member({ memberKey: 'c-t', contactId: 'c-t', name: 'Tasha Nguyen', role: 'tenant' }),
          member({
            memberKey: 'c-gone',
            contactId: 'c-gone',
            name: 'Del Ted',
            role: 'removed_contact',
            phoneLast4: '0155',
          }),
        ],
      }),
    });
    const gone = rosterRows()[1]!;
    expect(within(gone).getByText('removed contact')).toBeInTheDocument();
    expect(within(gone).queryByRole('link')).not.toBeInTheDocument();
  });

  it('mutes a member with no mobile number and names the reason', () => {
    renderCard({
      roster: view({
        members: [
          member({ memberKey: 'c-t', contactId: 'c-t', name: 'Tasha Nguyen', role: 'tenant' }),
          member({
            memberKey: 'c-pm',
            contactId: 'c-pm',
            name: 'Alicia Grant',
            role: 'pm',
            reachability: 'no_phone',
          }),
        ],
      }),
    });
    expect(
      within(rosterRows()[1]!).getByText('not on the group text - no mobile number'),
    ).toBeInTheDocument();
  });

  it('mutes an opted-out member and names THAT reason', () => {
    renderCard({
      roster: view({
        members: [
          member({ memberKey: 'c-t', contactId: 'c-t', name: 'Tasha Nguyen', role: 'tenant' }),
          member({
            memberKey: 'c-pm',
            contactId: 'c-pm',
            name: 'Alicia Grant',
            role: 'pm',
            reachability: 'opted_out',
          }),
        ],
      }),
    });
    expect(within(rosterRows()[1]!).getByText('not on the group text - opted out')).toBeInTheDocument();
  });

  it('says when a member shares a number with an earlier one (one message)', () => {
    renderCard({
      roster: view({
        members: [
          member({ memberKey: 'c-t', contactId: 'c-t', name: 'Tasha Nguyen', role: 'tenant' }),
          member({
            memberKey: 'c-pm',
            contactId: 'c-pm',
            name: 'Alicia Grant',
            role: 'pm',
            sharesPhoneWithName: 'Tasha Nguyen',
          }),
        ],
      }),
    });
    expect(
      within(rosterRows()[1]!).getByText('shares a number with Tasha Nguyen - one message'),
    ).toBeInTheDocument();
  });
});

describe('PeopleCard - unavailable + loading', () => {
  it("source 'unavailable' offers a retry and NEVER renders a default roster in its place", () => {
    renderCard({
      // Adversarial payload: even if members / a default name rode along, an
      // unreadable thread means we do not know who is on this roster (Task 3's
      // cardinal rule) - the card must show none of them.
      roster: view({
        source: 'unavailable',
        members: [member({ memberKey: 'c-l', contactId: 'c-l', name: 'Marcus Webb', role: 'landlord' })],
        defaultPrimaryName: 'Marcus Webb',
        threadExists: true,
      }),
    });
    expect(screen.getByText(/Couldn't load this roster/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Roster' })).not.toBeInTheDocument();
    expect(screen.queryByText('Marcus Webb')).not.toBeInTheDocument();
    expect(screen.queryByText(/property's default/)).not.toBeInTheDocument();
  });

  it('a failed fetch shows the same retry state, and Retry calls back', async () => {
    const { onRetry } = renderCard({ status: 'error', roster: null });
    expect(screen.getByText(/Couldn't load this roster/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('while loading it shows neither a roster nor an error', () => {
    renderCard({ status: 'loading', roster: null });
    expect(screen.queryByRole('list', { name: 'Roster' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load this roster/)).not.toBeInTheDocument();
  });
});

describe('PeopleCard - notes', () => {
  it('names the property default and DISABLES reset while a thread exists', () => {
    renderCard({
      roster: view({
        source: 'participants',
        customized: true,
        defaultPrimaryName: 'Marcus Webb',
        threadExists: true,
        canOpenGroup: false,
      }),
    });
    expect(
      screen.getByText("Customized for this tour - the property's default is Marcus Webb."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset to property default' })).toBeDisabled();
    expect(
      screen.getByText('members are on a live group text - add or remove them individually'),
    ).toBeInTheDocument();
  });

  it('customized with NO thread yet notes it without a reset control (Task 11 wires it)', () => {
    renderCard({
      roster: view({ source: 'plan', customized: true, defaultPrimaryName: 'Marcus Webb' }),
    });
    expect(
      screen.getByText("Customized for this tour - the property's default is Marcus Webb."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset to property default' })).not.toBeInTheDocument();
  });

  it('an uncustomized roster says nothing about a default', () => {
    renderCard();
    expect(screen.queryByText(/Customized for this/)).not.toBeInTheDocument();
  });

  it('warns that reminders are paused when the tenant is off the roster (D11)', () => {
    renderCard({ roster: view({ tenantOnRoster: false }) });
    expect(
      screen.getByText('Tenant is not on this roster - tour reminders are paused'),
    ).toBeInTheDocument();
  });

  it('says PLACEMENT NUDGES on the placement hub', () => {
    renderCard({ scope: 'placement', roster: view({ tenantOnRoster: false, customized: true }) });
    expect(
      screen.getByText('Tenant is not on this roster - placement nudges are paused'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Customized for this placement/)).toBeInTheDocument();
  });

  it('hints the caseworker on file whenever the tenant carries one', () => {
    renderCard({ caseworker: 'D. Okafor' });
    expect(
      screen.getByText('Caseworker on file: D. Okafor - not a contact record'),
    ).toBeInTheDocument();
  });

  it('shows no caseworker hint when the tenant has none', () => {
    renderCard();
    expect(screen.queryByText(/Caseworker on file/)).not.toBeInTheDocument();
  });

  it('explains why a group text cannot be opened when too few members are reachable', () => {
    renderCard({ roster: view({ canOpenGroup: false }) });
    expect(
      screen.getByText('Not enough people to open a group text - two reachable members are needed'),
    ).toBeInTheDocument();
  });

  it('never blames "too few people" once the group text already exists', () => {
    renderCard({
      roster: view({ source: 'participants', threadExists: true, canOpenGroup: false }),
    });
    expect(screen.queryByText(/Not enough people to open a group text/)).not.toBeInTheDocument();
  });
});

describe('PeopleCard - hub-owned rows + narrow viewport', () => {
  it('renders the hub page rows (Property, provenance) below the people list', () => {
    render(
      <MemoryRouter>
        <PeopleCard scope="placement" status="ready" roster={view()} onRetry={vi.fn()}>
          <div data-testid="hub-rows">Property</div>
        </PeopleCard>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('hub-rows')).toBeInTheDocument();
  });

  it('keeps the hub rows visible even while the roster is unavailable', () => {
    render(
      <MemoryRouter>
        <PeopleCard
          scope="tour"
          status="ready"
          roster={view({ source: 'unavailable', members: [] })}
          onRetry={vi.fn()}
        >
          <div data-testid="hub-rows">Property</div>
        </PeopleCard>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('hub-rows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('carries the name-line / role class hooks the <=860px wrap rule targets (spec 6.7)', () => {
    renderCard();
    const nameLine = within(rosterRows()[0]!).getByRole('link', { name: 'Tasha Nguyen' })
      .parentElement!;
    expect(nameLine.className).toContain('nameLine');
    expect(within(rosterRows()[0]!).getByText('tenant').className).toContain('role');
    // jsdom evaluates no CSS, so prove the wrap rule itself exists and targets
    // the same hook at the shared twoPaneShell breakpoint. Read from disk: both
    // `import ... ?raw` and `new URL(..., import.meta.url)` are rewritten by
    // Vite's asset pipeline, and vitest's cwd is this workspace root.
    const cardCss = readFileSync(
      join(process.cwd(), 'src/routes/shared/PeopleCard.module.css'),
      'utf8',
    );
    expect(cardCss).toContain('@media (max-width: 860px)');
    expect(cardCss).toMatch(/\.nameLine\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});

// --- Edit mode (spec 6.2 / 6.4, Task 11) -----------------------------------
// The card IS the roster editor. Every action persists ON CLICK (spec D5), and
// WHICH endpoint it persists through is the whole safety story (spec section 7):
// no thread -> the silent PLAN endpoints; a thread -> the OWNER-SCOPED
// live-members call-through, with an ADD gated behind the confirm dialog.

const PM_SUGGESTION: RosterSuggestion = {
  contactId: 'c-pm',
  name: 'Alicia Grant',
  lead: 'Also on this property',
  roleLabel: 'PM',
  primaryContact: true,
};
const TENANT_SUGGESTION: RosterSuggestion = {
  contactId: 'c-t',
  name: 'Tasha Nguyen',
  lead: 'On this tour',
  roleLabel: 'tenant',
};

function pmContact(): Contact {
  return {
    contactId: 'c-pm',
    type: 'landlord',
    firstName: 'Alicia',
    lastName: 'Grant',
    phone: '+14045550188',
  };
}

function preview(over: Partial<RosterPreview> = {}): RosterPreview {
  return {
    body: 'Adding Alicia Grant to this group text.',
    recipients: [
      { name: 'Tasha Nguyen', reachability: 'reachable' },
      { name: 'Alicia Grant', reachability: 'reachable' },
    ],
    recipientCount: 2,
    deferred: false,
    ...over,
  };
}

/** Render the card as the EDITOR and flip it into edit mode. */
async function renderEditing(
  over: Partial<PeopleCardProps> = {},
  suggestions: RosterSuggestion[] = [],
): Promise<{ onRetry: ReturnType<typeof vi.fn>; onApply: ReturnType<typeof vi.fn> }> {
  const onApply = vi.fn();
  const { onRetry } = renderCard({
    edit: { owner: { type: 'tour', id: 'tour-abc' }, suggestions, onApply },
    ...over,
  });
  await userEvent.click(screen.getByRole('button', { name: 'Edit people' }));
  return { onRetry, onApply };
}

describe('PeopleCard - edit mode', () => {
  it('Edit stops the rows being links, and Done returns to view mode', async () => {
    await renderEditing();
    expect(within(rosterRows()[0]!).queryByRole('link')).not.toBeInTheDocument();
    expect(within(rosterRows()[0]!).getByText('Tasha Nguyen')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done editing people' }));
    expect(within(rosterRows()[0]!).getByRole('link', { name: 'Tasha Nguyen' })).toBeInTheDocument();
  });

  it('removes a member through the PLAN endpoint, silently, when no thread exists', async () => {
    const next = view({ members: [view().members[0]!] });
    removeTourRosterMember.mockResolvedValue(next);
    const { onApply } = await renderEditing();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this tour' }));
    await waitFor(() => expect(removeTourRosterMember).toHaveBeenCalledWith('tour-abc', 'c-pm'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onApply).toHaveBeenCalledWith(next);
    expect(removeTourRosterLiveMember).not.toHaveBeenCalled();
  });

  it("DISABLES the last member's remove and says why", async () => {
    await renderEditing({ roster: view({ members: [view().members[0]!] }) });
    expect(screen.getByRole('button', { name: 'Remove Tasha Nguyen from this tour' })).toBeDisabled();
    expect(
      screen.getByText(
        'A roster needs at least one member. Add someone else before removing this one.',
      ),
    ).toBeInTheDocument();
  });

  it('suggests the property roster members who are not on this roster', async () => {
    addTourRosterMember.mockResolvedValue(view());
    await renderEditing({ roster: view({ members: [view().members[0]!] }) }, [PM_SUGGESTION]);
    expect(
      screen.getByText('Also on this property: Alicia Grant - PM - primary contact'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add Alicia Grant to this tour' }));
    await waitFor(() =>
      expect(addTourRosterMember).toHaveBeenCalledWith('tour-abc', { contactId: 'c-pm' }),
    );
  });

  it('restores a removed tenant in ONE click from the missing-tenant suggestion', async () => {
    addTourRosterMember.mockResolvedValue(view());
    const { onApply } = await renderEditing(
      { roster: view({ members: [view().members[1]!], tenantOnRoster: false }) },
      [TENANT_SUGGESTION],
    );
    expect(screen.getByText('On this tour: Tasha Nguyen - tenant')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add Tasha Nguyen to this tour' }));
    await waitFor(() =>
      expect(addTourRosterMember).toHaveBeenCalledWith('tour-abc', { contactId: 'c-t' }),
    );
    expect(onApply).toHaveBeenCalled();
  });

  it('adds ANY contact through the committed-pick search', async () => {
    getContacts.mockImplementation((params: { type: string }) =>
      Promise.resolve({
        contacts: params.type === 'landlord' ? [pmContact()] : [],
        nextCursor: null,
      }),
    );
    addTourRosterMember.mockResolvedValue(view());
    await renderEditing({ roster: view({ members: [view().members[0]!] }) });
    await userEvent.click(screen.getByRole('button', { name: '+ Add any contact' }));
    const search = await screen.findByRole('combobox', { name: 'Add any contact' });
    await userEvent.type(search, 'Alicia');
    await userEvent.click(await screen.findByRole('option', { name: 'Alicia Grant' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add contact to this tour' }));
    await waitFor(() =>
      expect(addTourRosterMember).toHaveBeenCalledWith('tour-abc', { contactId: 'c-pm' }),
    );
  });

  it('offers Reset only when the roster is customized and no thread exists', async () => {
    resetTourRoster.mockResolvedValue(view());
    const { onApply } = await renderEditing({
      roster: view({ source: 'plan', customized: true, defaultPrimaryName: 'Marcus Webb' }),
    });
    // Confirmless: it is a plan edit, nothing has been sent.
    await userEvent.click(screen.getByRole('button', { name: 'Reset to property default' }));
    await waitFor(() => expect(resetTourRoster).toHaveBeenCalledWith('tour-abc'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onApply).toHaveBeenCalled();
  });

  it('keeps Reset DISABLED once a thread exists (the plan was consumed)', async () => {
    await renderEditing({
      roster: view({ source: 'participants', customized: true, threadExists: true }),
    });
    expect(screen.getByRole('button', { name: 'Reset to property default' })).toBeDisabled();
    expect(resetTourRoster).not.toHaveBeenCalled();
  });
});

describe('PeopleCard - edit mode against a LIVE group text', () => {
  const live = (over: Partial<RosterView> = {}): RosterView =>
    view({ source: 'participants', threadExists: true, canOpenGroup: false, ...over });

  it('an ADD confirms first, then calls the OWNER-SCOPED live endpoint (never the raw relay route)', async () => {
    previewTourRosterAdd.mockResolvedValue(preview());
    addTourRosterLiveMember.mockResolvedValue(live());
    const { onApply } = await renderEditing({ roster: live({ members: [view().members[0]!] }) }, [
      PM_SUGGESTION,
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Add Alicia Grant to this tour' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Add Alicia Grant to the group text?',
    });
    expect(previewTourRosterAdd).toHaveBeenCalledWith('tour-abc', 'c-pm');
    // Nothing is written until the operator confirms.
    expect(addTourRosterLiveMember).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Adding Alicia Grant to this group text.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add and notify' }));
    await waitFor(() => expect(addTourRosterLiveMember).toHaveBeenCalledWith('tour-abc', 'c-pm'));
    expect(addConversationMember).not.toHaveBeenCalled();
    expect(addTourRosterMember).not.toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledWith(live());
  });

  it('a REMOVE goes straight through live-members BY MEMBER KEY - never a phone, never a confirm', async () => {
    removeTourRosterLiveMember.mockResolvedValue(live());
    await renderEditing({
      roster: live({
        members: [
          view().members[0]!,
          {
            memberKey: 'phone:+14045550199',
            phoneLast4: '0199',
            role: 'added',
            reachability: 'reachable',
          },
        ],
      }),
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove Number ending 0199 from this tour' }),
    );
    await waitFor(() =>
      expect(removeTourRosterLiveMember).toHaveBeenCalledWith('tour-abc', 'phone:+14045550199'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(removeConversationMember).not.toHaveBeenCalled();
  });
});

describe('PeopleCard - refusals', () => {
  it('NEVER resubmits a plan edit through the live endpoint on 409 thread_exists', async () => {
    addTourRosterMember.mockRejectedValue(
      new ApiError(409, 'thread_exists', 'thread_exists', {
        error: 'thread_exists',
        message: 'This tour already has a group text - use the live roster controls.',
      }),
    );
    const { onRetry } = await renderEditing({ roster: view({ members: [view().members[0]!] }) }, [
      PM_SUGGESTION,
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Add Alicia Grant to this tour' }));
    await waitFor(() => expect(addTourRosterMember).toHaveBeenCalledTimes(1));
    // The whole point: the dropped intent must NOT escalate into a member_added
    // text nobody confirmed.
    expect(addTourRosterLiveMember).not.toHaveBeenCalled();
    expect(addConversationMember).not.toHaveBeenCalled();
    expect(previewTourRosterAdd).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The card refetches and says the change was dropped.
    expect(onRetry).toHaveBeenCalled();
    expect(
      await screen.findByText(
        'A group text was just opened for this tour - that change was not applied. Try it again to notify the group.',
      ),
    ).toBeInTheDocument();
  });

  it("renders the server's own refusal copy on the row and refetches", async () => {
    removeTourRosterMember.mockRejectedValue(
      new ApiError(409, 'roster_conflict', 'roster_conflict', {
        error: 'roster_conflict',
        message: 'Someone else changed this roster at the same time. It has been refreshed.',
      }),
    );
    const { onRetry } = await renderEditing();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Alicia Grant from this tour' }));
    expect(
      await within(rosterRows()[1]!).findByText(
        'Someone else changed this roster at the same time. It has been refreshed.',
      ),
    ).toBeInTheDocument();
    expect(onRetry).toHaveBeenCalled();
  });
});
