import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from './Composer.js';
import { cannedAssets } from '../assets/canned/index.js';

interface Handlers {
  onSend?: ReturnType<typeof vi.fn>;
  onSetDeliveryProfile?: ReturnType<typeof vi.fn>;
}

function setup(h: Handlers = {}) {
  const onSend = h.onSend ?? vi.fn();
  const onSetDeliveryProfile = h.onSetDeliveryProfile ?? vi.fn();
  render(<Composer onSend={onSend} onSetDeliveryProfile={onSetDeliveryProfile} />);
  return { onSend, onSetDeliveryProfile };
}

test('the message textarea is reachable by label', () => {
  setup();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
});

test('typing + Send calls onSend with the body', async () => {
  const { onSend } = setup();
  await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'Hi there');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(onSend).toHaveBeenCalledWith({ body: 'Hi there', mediaUrls: [] });
});

test('Enter sends; Shift+Enter inserts a newline instead', async () => {
  const { onSend } = setup();
  const box = screen.getByRole('textbox', { name: 'Message' });
  await userEvent.type(box, 'line1{Shift>}{Enter}{/Shift}line2');
  expect(onSend).not.toHaveBeenCalled();
  expect(box).toHaveValue('line1\nline2');
  await userEvent.type(box, '{Enter}');
  expect(onSend).toHaveBeenCalledWith({ body: 'line1\nline2', mediaUrls: [] });
});

test('picking a canned image includes it in the sent mediaUrls', async () => {
  const { onSend } = setup();
  const asset = cannedAssets[0]!;
  await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'see photo');
  await userEvent.click(screen.getByRole('button', { name: new RegExp(asset.label, 'i') }));
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(onSend).toHaveBeenCalledWith({ body: 'see photo', mediaUrls: [asset.url] });
});

test('does not send an empty message', async () => {
  const { onSend } = setup();
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(onSend).not.toHaveBeenCalled();
});

test('clears the input after a successful send', async () => {
  setup();
  const box = screen.getByRole('textbox', { name: 'Message' });
  await userEvent.type(box, 'one');
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(box).toHaveValue('');
});

test('the delivery-profile toggle calls onSetDeliveryProfile', async () => {
  const { onSetDeliveryProfile } = setup();
  await userEvent.click(screen.getByRole('radio', { name: /fail/i }));
  expect(onSetDeliveryProfile).toHaveBeenCalledWith({ kind: 'fail' });
});

test('exposes the three delivery profiles as a radiogroup', () => {
  setup();
  const group = screen.getByRole('radiogroup', { name: /delivery/i });
  expect(group).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /normal/i })).toBeChecked();
  expect(screen.getByRole('radio', { name: /stall at sent/i })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /fail/i })).toBeInTheDocument();
});
