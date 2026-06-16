import React from 'react';
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

test('restores focus to the opener element when the dialog closes', async () => {
  // A trigger button that opens the dialog; closing must return focus to it.
  function Harness(): React.JSX.Element {
    const [open, setOpen] = React.useState(false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          Open dialog
        </button>
        {open && <AdHocDialog onSubmit={() => {}} onClose={() => setOpen(false)} />}
      </div>
    );
  }
  render(<Harness />);
  const opener = screen.getByRole('button', { name: /open dialog/i });
  opener.focus();
  await userEvent.click(opener);
  // Dialog open: its first field has focus, not the opener.
  expect(screen.getByLabelText(/label/i)).toHaveFocus();
  // Close via the close button; focus returns to the opener.
  await userEvent.click(screen.getByRole('button', { name: /close/i }));
  expect(opener).toHaveFocus();
});
