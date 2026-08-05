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
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { RosterMemberView, RosterView } from '../../api/index.js';
import { PeopleCard, type PeopleCardProps } from './PeopleCard.js';

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

function renderCard(over: Partial<PeopleCardProps> = {}): { onRetry: () => void } {
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
