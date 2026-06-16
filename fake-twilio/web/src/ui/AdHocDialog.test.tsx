import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdHocDialog } from './AdHocDialog.js';

test('is an accessible, labelled dialog', () => {
  render(<AdHocDialog onSubmit={() => {}} onClose={() => {}} />);
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveAccessibleName(/ad-hoc/i);
});

test('submitting calls onSubmit with the entered label, role and number', async () => {
  const onSubmit = vi.fn();
  render(<AdHocDialog onSubmit={onSubmit} onClose={() => {}} />);
  await userEvent.type(screen.getByLabelText(/label/i), 'Surprise Caller');
  await userEvent.selectOptions(screen.getByLabelText(/role/i), 'tenant');
  await userEvent.type(screen.getByLabelText(/number \(optional\)/i), '+15550109999');
  await userEvent.click(screen.getByRole('button', { name: /add/i }));
  expect(onSubmit).toHaveBeenCalledWith({
    label: 'Surprise Caller',
    role: 'tenant',
    number: '+15550109999',
  });
});

test('omits an empty optional number', async () => {
  const onSubmit = vi.fn();
  render(<AdHocDialog onSubmit={onSubmit} onClose={() => {}} />);
  await userEvent.type(screen.getByLabelText(/label/i), 'No Number');
  await userEvent.click(screen.getByRole('button', { name: /add/i }));
  expect(onSubmit).toHaveBeenCalledWith({ label: 'No Number', role: 'landlord' });
});

test('surfaces a server validation error inline', () => {
  render(<AdHocDialog onSubmit={() => {}} onClose={() => {}} error="Number already in use" />);
  expect(screen.getByRole('alert')).toHaveTextContent('Number already in use');
});

test('Escape calls onClose', async () => {
  const onClose = vi.fn();
  render(<AdHocDialog onSubmit={() => {}} onClose={onClose} />);
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});

test('the close button calls onClose', async () => {
  const onClose = vi.fn();
  render(<AdHocDialog onSubmit={() => {}} onClose={onClose} />);
  await userEvent.click(screen.getByRole('button', { name: /close/i }));
  expect(onClose).toHaveBeenCalled();
});
