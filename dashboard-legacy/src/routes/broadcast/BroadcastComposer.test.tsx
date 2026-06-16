// BroadcastComposer tests — Share-Listings pre-fill, audience preview count,
// over-cap refusal, send success + 400/409 error handling. Mock the broadcast
// endpoints; keep ApiError real for instanceof. No network.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BroadcastPreviewResult,
  CreateBroadcastResult,
  SendBroadcastResult,
  UnitItem,
} from '../../api';

const api = vi.hoisted(() => ({
  createBroadcast: vi.fn(),
  previewBroadcast: vi.fn(),
  sendBroadcast: vi.fn(),
}));

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api');
  return {
    ...actual,
    createBroadcast: api.createBroadcast,
    previewBroadcast: api.previewBroadcast,
    sendBroadcast: api.sendBroadcast,
  };
});

const { BroadcastComposer } = await import('./BroadcastComposer');
const { ToastProvider } = await import('../../ui');
const { ApiError } = await import('../../api');

function unit(over: Partial<UnitItem> = {}): UnitItem {
  return {
    unitId: 'u1',
    landlordId: 'k1',
    status: 'available',
    beds: 2,
    jurisdiction: 'Detroit HC',
    rent_min: 1200,
    rent_max: 1500,
    address: '123 Main St',
    ...over,
  };
}

function created(over: Partial<CreateBroadcastResult> = {}): CreateBroadcastResult {
  return { broadcastId: 'b1', status: 'draft', estimatedCount: 3, truncated: false, ...over };
}

function previewResult(over: Partial<BroadcastPreviewResult> = {}): BroadcastPreviewResult {
  return {
    count: 3,
    truncated: false,
    sample: [
      { contactId: 'c1', firstName: 'Alice', phone: '+13135550001' },
      { contactId: 'c2', phone: '+13135550002' },
    ],
    ...over,
  };
}

function renderComposer(props: Partial<Parameters<typeof BroadcastComposer>[0]> = {}): {
  onSent: ReturnType<typeof vi.fn>;
} {
  const onSent = vi.fn();
  render(
    <ToastProvider>
      <BroadcastComposer open onClose={vi.fn()} unit={unit()} onSent={onSent} {...props} />
    </ToastProvider>,
  );
  return { onSent };
}

beforeEach(() => {
  api.createBroadcast.mockReset();
  api.previewBroadcast.mockReset();
  api.sendBroadcast.mockReset();
});

describe('<BroadcastComposer>', () => {
  it('pre-fills bedroom size, housing authority, and the flyer-link template from the unit', () => {
    renderComposer();
    expect(screen.getByLabelText(/Bedroom size/)).toHaveValue(2);
    expect(screen.getByLabelText(/Housing authority/)).toHaveValue('Detroit HC');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toMatch(/\[FlyerLink\]/);
  });

  it('previews the audience count + sample and enables Send', async () => {
    api.createBroadcast.mockResolvedValue(created());
    api.previewBroadcast.mockResolvedValue(previewResult());
    renderComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Preview audience' }));

    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    // The unnamed contact falls back to a formatted phone (honest identity).
    expect(screen.getByText('(313) 555-0002')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send broadcast' })).toBeEnabled(),
    );
    // Create body carried the unit + filter narrowers.
    expect(api.createBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        unitId: 'u1',
        audience_filter: { housing_authority: 'Detroit HC', bedroomSize: 2 },
      }),
    );
  });

  it('refuses send on an over-cap (truncated) preview', async () => {
    api.createBroadcast.mockResolvedValue(created({ truncated: true }));
    api.previewBroadcast.mockResolvedValue(previewResult({ count: 2000, truncated: true }));
    renderComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Preview audience' }));

    expect(await screen.findByText('Over cap — narrow your filter')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send broadcast' })).toBeDisabled();
    expect(api.sendBroadcast).not.toHaveBeenCalled();
  });

  it('keeps Send disabled when the audience is empty', async () => {
    api.createBroadcast.mockResolvedValue(created({ estimatedCount: 0 }));
    api.previewBroadcast.mockResolvedValue(previewResult({ count: 0, sample: [] }));
    renderComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Preview audience' }));

    expect(await screen.findByText('No one matches')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send broadcast' })).toBeDisabled();
  });

  it('sends successfully and calls onSent with the broadcastId', async () => {
    api.createBroadcast.mockResolvedValue(created());
    api.previewBroadcast.mockResolvedValue(previewResult());
    const sent: SendBroadcastResult = { broadcastId: 'b1', status: 'sending', count: 3 };
    api.sendBroadcast.mockResolvedValue(sent);
    const { onSent } = renderComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Preview audience' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send broadcast' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send broadcast' }));

    await waitFor(() => expect(api.sendBroadcast).toHaveBeenCalledWith('b1'));
    await waitFor(() => expect(onSent).toHaveBeenCalledWith('b1'));
  });

  it('surfaces the 400 audience_too_large refusal and re-previews', async () => {
    api.createBroadcast.mockResolvedValue(created());
    api.previewBroadcast.mockResolvedValue(previewResult());
    api.sendBroadcast.mockRejectedValueOnce(
      new ApiError(400, 'audience_too_large', 'audience_too_large', {
        error: 'audience_too_large',
        message: 'audience of 1600 exceeds the 1500 recipient cap',
        count: 1600,
        truncated: false,
      }),
    );
    renderComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Preview audience' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send broadcast' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send broadcast' }));

    // The cap message shows in both the inline form error and the toast.
    expect((await screen.findAllByText(/exceeds the 1500 recipient cap/)).length).toBeGreaterThan(0);
  });

  it('surfaces the 409 broadcast_not_draft case', async () => {
    api.createBroadcast.mockResolvedValue(created());
    api.previewBroadcast.mockResolvedValue(previewResult());
    api.sendBroadcast.mockRejectedValueOnce(
      new ApiError(409, 'broadcast_not_draft', 'broadcast_not_draft'),
    );
    renderComposer();

    fireEvent.click(screen.getByRole('button', { name: 'Preview audience' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send broadcast' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send broadcast' }));

    // The message shows in both the inline form error and the toast.
    expect((await screen.findAllByText(/already sent/)).length).toBeGreaterThan(0);
  });
});
