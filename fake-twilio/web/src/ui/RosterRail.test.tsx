import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RosterRail } from './RosterRail.js';
import type { GroupSnapshot, Persona } from '../api/types.js';

function persona(over: Partial<Persona> = {}): Persona {
  return {
    id: over.id ?? 'p1',
    label: over.label ?? 'Pat Landlord',
    role: over.role ?? 'landlord',
    number: over.number ?? '+15550100001',
    adHoc: over.adHoc ?? false,
    ...over,
  };
}

const personas: Persona[] = [
  persona({ id: 'l1', label: 'Pat Landlord', role: 'landlord', number: '+15550100001' }),
  persona({ id: 't1', label: 'Tara Tenant', role: 'tenant', number: '+15550100002' }),
  persona({ id: 'pm1', label: 'Morgan PM', role: 'pm', number: '+15550100003' }),
];

test('groups personas under role headings', () => {
  render(<RosterRail personas={personas} unreadByNumber={{}} selected={null} onSelect={() => {}} onAddAdHoc={() => {}} />);
  expect(screen.getByRole('heading', { name: /landlord/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /tenant/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /pm/i })).toBeInTheDocument();
});

test('each persona row is a button with label + number', () => {
  render(<RosterRail personas={personas} unreadByNumber={{}} selected={null} onSelect={() => {}} onAddAdHoc={() => {}} />);
  const row = screen.getByRole('button', { name: /Tara Tenant/ });
  expect(row).toHaveTextContent('+15550100002');
});

test('clicking a row calls onSelect with the party number', async () => {
  const onSelect = vi.fn();
  render(<RosterRail personas={personas} unreadByNumber={{}} selected={null} onSelect={onSelect} onAddAdHoc={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: /Pat Landlord/ }));
  expect(onSelect).toHaveBeenCalledWith('+15550100001');
});

test('the selected row is marked aria-current', () => {
  render(<RosterRail personas={personas} unreadByNumber={{}} selected="+15550100002" onSelect={() => {}} onAddAdHoc={() => {}} />);
  const row = screen.getByRole('button', { name: /Tara Tenant/ });
  expect(row).toHaveAttribute('aria-current', 'true');
});

test('renders an unread badge with the count', () => {
  render(<RosterRail personas={personas} unreadByNumber={{ '+15550100002': 3 }} selected={null} onSelect={() => {}} onAddAdHoc={() => {}} />);
  const row = screen.getByRole('button', { name: /Tara Tenant/ });
  expect(row).toHaveTextContent('3');
  expect(row).toHaveAccessibleName(/3 unread/i);
});

test('has an ad-hoc number button that calls onAddAdHoc', async () => {
  const onAddAdHoc = vi.fn();
  render(<RosterRail personas={personas} unreadByNumber={{}} selected={null} onSelect={() => {}} onAddAdHoc={onAddAdHoc} />);
  await userEvent.click(screen.getByRole('button', { name: /ad-hoc number/i }));
  expect(onAddAdHoc).toHaveBeenCalledTimes(1);
});

// ---- "Group texts" section (traffic-inferred relay groups) -------------------

const groups: GroupSnapshot[] = [
  {
    poolNumber: '+15550160001',
    members: [
      { number: '+15550170001', label: 'Diana Osei' },
      { number: '+15550170003', label: 'Gloria Mensah' },
    ],
    entries: [],
    lastActivityAt: '2026-06-15T00:00:00.000Z',
  },
  {
    poolNumber: '+15550160002',
    members: [{ number: '+15550170002', label: 'Ben Tenant' }],
    entries: [],
    lastActivityAt: '2026-06-15T01:00:00.000Z',
  },
];

test('renders a Group texts section: one row per group with formatted pool + member count', () => {
  render(
    <RosterRail
      personas={personas}
      unreadByNumber={{}}
      selected={null}
      onSelect={() => {}}
      onAddAdHoc={() => {}}
      groups={groups}
      groupUnreadByPool={{}}
      selectedGroup={null}
      onSelectGroup={() => {}}
    />,
  );
  expect(screen.getByRole('heading', { name: /group texts/i })).toBeInTheDocument();
  const row = screen.getByRole('button', { name: /\(555\) 016-0001/ });
  expect(row).toHaveTextContent('2 members');
  expect(screen.getByRole('button', { name: /\(555\) 016-0002/ })).toHaveTextContent('1 member');
});

test('renders NO Group texts section when there are no groups', () => {
  render(
    <RosterRail
      personas={personas}
      unreadByNumber={{}}
      selected={null}
      onSelect={() => {}}
      onAddAdHoc={() => {}}
      groups={[]}
      groupUnreadByPool={{}}
      selectedGroup={null}
      onSelectGroup={() => {}}
    />,
  );
  expect(screen.queryByRole('heading', { name: /group texts/i })).not.toBeInTheDocument();
});

test('clicking a group row calls onSelectGroup with the pool number (not onSelect)', async () => {
  const onSelect = vi.fn();
  const onSelectGroup = vi.fn();
  render(
    <RosterRail
      personas={personas}
      unreadByNumber={{}}
      selected={null}
      onSelect={onSelect}
      onAddAdHoc={() => {}}
      groups={groups}
      groupUnreadByPool={{}}
      selectedGroup={null}
      onSelectGroup={onSelectGroup}
    />,
  );
  await userEvent.click(screen.getByRole('button', { name: /\(555\) 016-0001/ }));
  expect(onSelectGroup).toHaveBeenCalledWith('+15550160001');
  expect(onSelect).not.toHaveBeenCalled();
});

test('the selected group row is marked aria-current', () => {
  render(
    <RosterRail
      personas={personas}
      unreadByNumber={{}}
      selected={null}
      onSelect={() => {}}
      onAddAdHoc={() => {}}
      groups={groups}
      groupUnreadByPool={{}}
      selectedGroup="+15550160002"
      onSelectGroup={() => {}}
    />,
  );
  expect(screen.getByRole('button', { name: /\(555\) 016-0002/ })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('button', { name: /\(555\) 016-0001/ })).not.toHaveAttribute('aria-current');
});

test('renders a group unread badge with the count (consistent with persona rows)', () => {
  render(
    <RosterRail
      personas={personas}
      unreadByNumber={{}}
      selected={null}
      onSelect={() => {}}
      onAddAdHoc={() => {}}
      groups={groups}
      groupUnreadByPool={{ '+15550160001': 4 }}
      selectedGroup={null}
      onSelectGroup={() => {}}
    />,
  );
  const row = screen.getByRole('button', { name: /\(555\) 016-0001/ });
  expect(row).toHaveTextContent('4');
  expect(row).toHaveAccessibleName(/4 unread/i);
});
