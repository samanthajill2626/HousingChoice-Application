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

test('keeps the composed message + picked image when the send rejects', async () => {
  const onSend = vi.fn().mockRejectedValue(new Error('engine refused it'));
  setup({ onSend });
  const box = screen.getByRole('textbox', { name: 'Message' });
  await userEvent.type(box, 'keep me');
  await userEvent.click(screen.getByRole('button', { name: new RegExp(cannedAssets[0]!.label, 'i') }));
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(onSend).toHaveBeenCalledWith({ body: 'keep me', mediaUrls: [cannedAssets[0]!.url] });
  // Rejected → input is preserved for a retry, and the image stays picked.
  expect(box).toHaveValue('keep me');
  expect(screen.getByRole('button', { name: new RegExp(cannedAssets[0]!.label, 'i') })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('the delivery-profile toggle calls onSetDeliveryProfile', async () => {
  const { onSetDeliveryProfile } = setup();
  await userEvent.click(screen.getByRole('radio', { name: /fail/i }));
  expect(onSetDeliveryProfile).toHaveBeenCalledWith({ kind: 'fail' });
});

test('reverts the delivery profile to Normal when resetSignal changes (one-shot consumed)', async () => {
  const onSetDeliveryProfile = vi.fn();
  const { rerender } = render(
    <Composer onSend={vi.fn()} onSetDeliveryProfile={onSetDeliveryProfile} resetSignal={0} />,
  );
  await userEvent.click(screen.getByRole('radio', { name: /fail/i }));
  expect(screen.getByRole('radio', { name: /fail/i })).toBeChecked();

  // The parent signals the engine consumed the one-shot profile → radio reverts.
  rerender(<Composer onSend={vi.fn()} onSetDeliveryProfile={onSetDeliveryProfile} resetSignal={1} />);
  expect(screen.getByRole('radio', { name: /normal/i })).toBeChecked();
  expect(screen.getByRole('radio', { name: /fail/i })).not.toBeChecked();
});

test('does not reset the profile on mount (initial resetSignal is ignored)', () => {
  const onSetDeliveryProfile = vi.fn();
  render(<Composer onSend={vi.fn()} onSetDeliveryProfile={onSetDeliveryProfile} resetSignal={7} />);
  // A non-zero initial signal must not clobber the default; Normal stays checked
  // but only because nothing armed it — the mount run is skipped, not applied.
  expect(screen.getByRole('radio', { name: /normal/i })).toBeChecked();
});

test('exposes the three delivery profiles as a radiogroup', () => {
  setup();
  const group = screen.getByRole('radiogroup', { name: /delivery/i });
  expect(group).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /normal/i })).toBeChecked();
  expect(screen.getByRole('radio', { name: /stall at sent/i })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /fail/i })).toBeInTheDocument();
});
