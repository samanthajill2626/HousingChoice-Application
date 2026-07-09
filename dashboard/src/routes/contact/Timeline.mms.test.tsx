import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Timeline } from './Timeline.js';
import { ApiError } from '../../api/index.js';
import type { TimelineItem } from '../../api/index.js';

// Mock ONLY uploadMedia; everything else in the api barrel stays real (ApiError,
// types) so the composer's error mapping and the render side are exercised for real.
vi.mock('../../api/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/index.js')>();
  return { ...actual, uploadMedia: vi.fn() };
});
import { uploadMedia } from '../../api/index.js';

const mockedUpload = vi.mocked(uploadMedia);

/** A valid (allowlisted) image file of a given byte size. */
function imageFile(name = 'photo.png', size = 2048, type = 'image/png'): File {
  return new File([new Uint8Array(size)], name, { type });
}

function renderComposer(props: Partial<React.ComponentProps<typeof Timeline>> = {}) {
  const items: TimelineItem[] = props.items ?? [];
  return render(
    <MemoryRouter>
      <Timeline
        status="ready"
        items={items}
        source="server"
        replyToPhone="+14705550148"
        canSend
        onSend={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

const fileInput = (): HTMLInputElement =>
  screen.getByLabelText('Attach files') as HTMLInputElement;

// jsdom has no URL.createObjectURL/revokeObjectURL; add them for the image chip
// preview path. (This file's jsdom global is isolated, so the stubs never leak.)
beforeEach(() => {
  mockedUpload.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

describe('Timeline outbound MMS composer', () => {
  it('uploads a picked file on select and shows a chip with the filename', async () => {
    mockedUpload.mockResolvedValue({ key: 'uploads/abc', contentType: 'image/png', size: 2048 });
    renderComposer();
    fireEvent.change(fileInput(), { target: { files: [imageFile('room.png')] } });
    // The chip appears immediately in the "Attachments" list...
    const list = screen.getByRole('list', { name: 'Attachments' });
    expect(list).toHaveTextContent('room.png');
    expect(mockedUpload).toHaveBeenCalledTimes(1);
    // ...and once the upload resolves the removal control is available.
    await screen.findByRole('button', { name: 'Remove room.png' });
    expect(screen.queryByText('Uploading...')).not.toBeInTheDocument();
  });

  it('shows an uploading state and BLOCKS Send until the upload finishes', async () => {
    let resolveUpload!: (v: { key: string; contentType: string; size: number }) => void;
    mockedUpload.mockReturnValue(
      new Promise((res) => {
        resolveUpload = res;
      }),
    );
    renderComposer();
    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });
    // In-flight: progress text + Send disabled (a still-uploading attachment must
    // not be silently dropped from the message).
    expect(screen.getByText('Uploading...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    resolveUpload({ key: 'uploads/x', contentType: 'image/png', size: 2048 });
    // Once done, an attachment alone enables Send (body OR attachments).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  });

  it('surfaces an inline error on the chip when the upload fails', async () => {
    mockedUpload.mockRejectedValue(new ApiError(413, 'file_too_large', 'file_too_large'));
    renderComposer();
    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });
    expect(await screen.findByText(/Too large/i)).toBeInTheDocument();
    // A failed upload contributes no key, so with an empty body Send stays disabled.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('removes a chip when its remove control is clicked', async () => {
    mockedUpload.mockResolvedValue({ key: 'uploads/abc', contentType: 'image/png', size: 2048 });
    renderComposer();
    fireEvent.change(fileInput(), { target: { files: [imageFile('doc.png')] } });
    const remove = await screen.findByRole('button', { name: 'Remove doc.png' });
    fireEvent.click(remove);
    expect(screen.queryByText('doc.png')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  it('rejects an unsupported file type WITHOUT uploading it', () => {
    renderComposer();
    fireEvent.change(fileInput(), {
      target: { files: [new File(['x'], 'archive.zip', { type: 'application/zip' })] },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/unsupported file type/i);
    expect(mockedUpload).not.toHaveBeenCalled();
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  it('rejects a file over 5MB WITHOUT uploading it', () => {
    renderComposer();
    fireEvent.change(fileInput(), {
      target: { files: [imageFile('big.png', 5 * 1024 * 1024 + 1)] },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/too large/i);
    expect(mockedUpload).not.toHaveBeenCalled();
  });

  it('rejects the 11th file (max 10) WITHOUT uploading it', async () => {
    mockedUpload.mockResolvedValue({ key: 'uploads/k', contentType: 'image/png', size: 16 });
    renderComposer();
    const eleven = Array.from({ length: 11 }, (_, i) => imageFile(`f${i}.png`, 16));
    fireEvent.change(fileInput(), { target: { files: eleven } });
    expect(screen.getByRole('alert')).toHaveTextContent(/at most 10 files/i);
    // Only the first 10 were accepted + uploaded.
    expect(mockedUpload).toHaveBeenCalledTimes(10);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^Remove/ })).toHaveLength(10),
    );
  });

  it('rejects a file that would exceed the 5MB total WITHOUT uploading it', async () => {
    mockedUpload.mockResolvedValue({ key: 'uploads/k', contentType: 'image/png', size: 16 });
    renderComposer();
    // 3MB accepted; a second 3MB pushes the total over 5MB and is rejected.
    fireEvent.change(fileInput(), { target: { files: [imageFile('a.png', 3 * 1024 * 1024)] } });
    fireEvent.change(fileInput(), { target: { files: [imageFile('b.png', 3 * 1024 * 1024)] } });
    expect(screen.getByRole('alert')).toHaveTextContent(/5 MB total limit/i);
    expect(mockedUpload).toHaveBeenCalledTimes(1); // only the first file uploaded
    await screen.findByRole('button', { name: 'Remove a.png' });
  });

  it('carries the uploaded attachmentKeys to onSend alongside the body', async () => {
    mockedUpload.mockResolvedValue({ key: 'uploads/abc', contentType: 'image/png', size: 2048 });
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer({ onSend });
    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });
    await screen.findByRole('button', { name: /Remove/ });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'see attached' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('see attached', ['uploads/abc']);
    // Chips clear after a successful send.
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument(),
    );
  });

  it('enables Send with an attachment and NO body (body OR attachments)', async () => {
    mockedUpload.mockResolvedValue({ key: 'uploads/abc', contentType: 'image/png', size: 2048 });
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer({ onSend });
    // Empty body, no attachment -> disabled.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // Attachment-only send: onSend gets an empty body + the keys.
    expect(onSend).toHaveBeenCalledWith('', ['uploads/abc']);
    // Let the send resolve (chips clear) so no state update escapes act().
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument(),
    );
  });

  it('restores the chips when an attachment send fails (nothing lost)', async () => {
    mockedUpload.mockResolvedValue({ key: 'uploads/abc', contentType: 'image/png', size: 2048 });
    const onSend = vi.fn().mockRejectedValue(new ApiError(409, 'contact_opted_out', 'x'));
    renderComposer({ onSend });
    fireEvent.change(fileInput(), { target: { files: [imageFile('keep.png')] } });
    await screen.findByRole('button', { name: 'Remove keep.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('alert'); // the refusal reason
    // The chip is back so the operator does not lose their attachment.
    expect(screen.getByRole('button', { name: 'Remove keep.png' })).toBeInTheDocument();
  });

  it('BLOCKS Send while any chip is errored, so an errored attachment is never silently dropped', async () => {
    // First upload succeeds (a good chip), the second fails (an errored chip).
    // A send with text + the good chip + the errored chip must NOT go out
    // silently omitting the failed file: Send is blocked with an inline warning.
    mockedUpload
      .mockResolvedValueOnce({ key: 'uploads/good', contentType: 'image/png', size: 2048 })
      .mockRejectedValueOnce(new ApiError(413, 'file_too_large', 'file_too_large'));
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer({ onSend });

    fireEvent.change(fileInput(), { target: { files: [imageFile('good.png')] } });
    await screen.findByRole('button', { name: 'Remove good.png' });
    fireEvent.change(fileInput(), { target: { files: [imageFile('bad.png')] } });
    // The errored chip surfaces its failure (wait for the rejection to settle).
    await screen.findByText(/attachment failed to upload/i);

    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'see attached' } });

    // Send is disabled even with a good chip + text: the errored chip blocks it.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();

    // Removing the errored chip unblocks Send (the good chip + text remain).
    fireEvent.click(screen.getByRole('button', { name: 'Remove bad.png' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('see attached', ['uploads/good']);
    // Let the send resolve (chips clear) so no state update escapes act().
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument(),
    );
  });

  it('shows an attachment count on an optimistic (queued, no-sid) bubble', () => {
    // The optimistic row the consumers add carries placeholder media_attachments
    // and a temp tsMsgId with no provider sid -> the bubble renders a count chip.
    const optimistic: TimelineItem = {
      kind: 'message',
      id: 'optimistic:1',
      at: '2026-06-08T09:20:00',
      conversationId: 'c1',
      tsMsgId: 'optimistic:1', // no "#": no derivable sid
      direction: 'outbound',
      author: 'teammate',
      type: 'mms',
      delivery_status: 'queued',
      body: 'here you go',
      media_attachments: [{ s3Key: 'uploads/abc', contentType: 'application/octet-stream' }],
    };
    renderComposer({ items: [optimistic] });
    expect(screen.getByText(/1 attachment/i)).toBeInTheDocument();
  });

  it('keeps attachment chips component-local: a keyed remount drops them (no cross-channel leak)', async () => {
    // The tour page keys each channel by conversationId; switching channels
    // REMOUNTS the Timeline. Attachment chips are component-local useState, so the
    // remounted composer starts empty - chips can never leak across tabs.
    mockedUpload.mockResolvedValue({ key: 'uploads/abc', contentType: 'image/png', size: 2048 });
    const { rerender } = render(
      <MemoryRouter>
        <Timeline
          key="conv-a"
          status="ready"
          items={[]}
          source="server"
          canSend
          onSend={vi.fn()}
          resetScrollKey="conv-a"
        />
      </MemoryRouter>,
    );
    fireEvent.change(fileInput(), { target: { files: [imageFile('a-only.png')] } });
    await screen.findByRole('button', { name: 'Remove a-only.png' });

    // Switch channels: a DIFFERENT key remounts a fresh Timeline instance.
    rerender(
      <MemoryRouter>
        <Timeline
          key="conv-b"
          status="ready"
          items={[]}
          source="server"
          canSend
          onSend={vi.fn()}
          resetScrollKey="conv-b"
        />
      </MemoryRouter>,
    );
    // The other channel shows NONE of the first channel's chips.
    expect(screen.queryByText('a-only.png')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });
});
