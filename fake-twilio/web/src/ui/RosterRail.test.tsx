import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RosterRail } from './RosterRail.js';
import type { Persona } from '../api/types.js';

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
