import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Timeline } from './Timeline.js';
import { ApiError } from '../../api/index.js';
import type { MmsMediaAttachment, TimelineItem } from '../../api/index.js';

// Mock ONLY the three upload-flow fns; everything else in the api barrel stays
// real (ApiError, types) so the composer's error mapping and the render side are
// exercised for real.
vi.mock('../../api/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/index.js')>();
  return {
    ...actual,
    presignMmsMedia: vi.fn(),
    uploadToPresignedPost: vi.fn(),
    confirmMmsMedia: vi.fn(),
  };
});
import { presignMmsMedia, uploadToPresignedPost, confirmMmsMedia } from '../../api/index.js';

const mockedPresign = vi.mocked(presignMmsMedia);
const mockedS3Post = vi.mocked(uploadToPresignedPost);
const mockedConfirm = vi.mocked(confirmMmsMedia);

/** Wire the happy-path presign -> S3 POST -> confirm flow returning `att`. */
function mockUploadFlow(att: Partial<MmsMediaAttachment> & { s3Key: string }): void {
  mockedPresign.mockResolvedValue({ key: att.originalKey ?? att.s3Key, post: { url: 'https://s3.local/b', fields: {} } });
  mockedS3Post.mockResolvedValue(undefined);
  mockedConfirm.mockResolvedValue({
    contentType: 'image/png',
    size: 2048,
    originalKey: att.originalKey ?? att.s3Key,
    ...att,
  } as MmsMediaAttachment);
}

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
  mockedPresign.mockReset();
  mockedS3Post.mockReset();
  mockedConfirm.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

describe('Timeline outbound MMS composer', () => {
  it('uploads a picked file via presign -> S3 -> confirm and shows a chip', async () => {
    mockUploadFlow({ s3Key: 'uploads/abc' });
    renderComposer();
    fireEvent.change(fileInput(), { target: { files: [imageFile('room.png')] } });
    // The chip appears immediately in the "Attachments" list...
    const list = screen.getByRole('list', { name: 'Attachments' });
    expect(list).toHaveTextContent('room.png');
    expect(mockedPresign).toHaveBeenCalledWith('image/png');
    // ...and once the flow resolves the removal control is available.
    await screen.findByRole('button', { name: 'Remove room.png' });
    expect(mockedS3Post).toHaveBeenCalledTimes(1);
    expect(mockedConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Uploading...')).not.toBeInTheDocument();
  });

  it('shows an uploading state and BLOCKS Send until confirm finishes', async () => {
    mockedPresign.mockResolvedValue({ key: 'uploads/x', post: { url: 'u', fields: {} } });
    mockedS3Post.mockResolvedValue(undefined);
    let resolveConfirm!: (v: MmsMediaAttachment) => void;
    mockedConfirm.mockReturnValue(
      new Promise((res) => {
        resolveConfirm = res;
      }),
    );
    renderComposer();
    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });
    // In-flight (upload or server transcode): progress text + Send disabled (a
    // still-uploading attachment must not be silently dropped from the message).
    expect(screen.getByText('Uploading...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    resolveConfirm({ s3Key: 'uploads/x', contentType: 'image/png', size: 2048, originalKey: 'uploads/x' });
    // Once done, an attachment alone enables Send (body OR attachments).
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  });

  it('surfaces an inline error on the chip when the S3 upload fails', async () => {
    mockedPresign.mockResolvedValue({ key: 'uploads/x', post: { url: 'u', fields: {} } });
    mockedS3Post.mockRejectedValue(new ApiError(400, 's3_upload_failed', 'S3 upload failed (400)'));
    renderComposer();
    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });
    expect(await screen.findByText(/Upload failed/i)).toBeInTheDocument();
    // A failed upload contributes no key, so with an empty body Send stays disabled.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('multi-page pdf shows the page-1-only note and stays sendable', async () => {
    mockedPresign.mockResolvedValue({ key: 'uploads/o', post: { url: 'u', fields: {} } });
    mockedS3Post.mockResolvedValue(undefined);
    mockedConfirm.mockResolvedValue({
      s3Key: 'uploads/d',
      contentType: 'image/jpeg',
      size: 10,
      originalKey: 'uploads/o',
      transcodedFrom: 'application/pdf',
      pdfPageCount: 3,
    });
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer({ onSend });
    fireEvent.change(fileInput(), {
      target: { files: [new File(['%PDF'], 'lease.pdf', { type: 'application/pdf' })] },
    });
    await screen.findByRole('button', { name: 'Remove lease.pdf' });
    expect(screen.getByText(/only the first page/i)).toBeInTheDocument();
    // Soft note only - Send stays enabled and carries the rendition + original.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('', ['uploads/d'], ['uploads/o']);
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument(),
    );
  });

  it('single-page pdf shows NO page note', async () => {
    mockedPresign.mockResolvedValue({ key: 'uploads/o', post: { url: 'u', fields: {} } });
    mockedS3Post.mockResolvedValue(undefined);
    mockedConfirm.mockResolvedValue({
      s3Key: 'uploads/d',
      contentType: 'image/jpeg',
      size: 10,
      originalKey: 'uploads/o',
      transcodedFrom: 'application/pdf',
      pdfPageCount: 1,
    });
    renderComposer();
    fireEvent.change(fileInput(), {
      target: { files: [new File(['%PDF'], 'flyer.pdf', { type: 'application/pdf' })] },
    });
    await screen.findByRole('button', { name: 'Remove flyer.pdf' });
    expect(screen.queryByText(/only the first page/i)).not.toBeInTheDocument();
  });

  it('shows the transcode_failed detail on the chip', async () => {
    mockedPresign.mockResolvedValue({ key: 'uploads/o', post: { url: 'u', fields: {} } });
    mockedS3Post.mockResolvedValue(undefined);
    mockedConfirm.mockRejectedValue(
      new ApiError(400, 'transcode_failed', 'transcode_failed', {
        error: 'transcode_failed',
        detail: 'Input buffer contains unsupported image format',
      }),
    );
    renderComposer();
    fireEvent.change(fileInput(), { target: { files: [imageFile('broken.webp', 64, 'image/webp')] } });
    expect(
      await screen.findByText(/Couldn't process this file: Input buffer/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('removes a chip when its remove control is clicked', async () => {
    mockUploadFlow({ s3Key: 'uploads/abc' });
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
    expect(mockedPresign).not.toHaveBeenCalled();
    expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  it('rejects a file over the 20MB source cap WITHOUT uploading it', () => {
    // Auto-fit raised the per-file SOURCE ceiling to 20MB (the server shrinks
    // oversized images at confirm); over that, the presign policy would reject
    // the POST anyway, so the pick is refused up front.
    renderComposer();
    fireEvent.change(fileInput(), {
      target: { files: [imageFile('big.png', 20 * 1024 * 1024 + 1)] },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/too large/i);
    expect(mockedPresign).not.toHaveBeenCalled();
  });

  it('rejects the 11th file (max 10) WITHOUT uploading it', async () => {
    mockUploadFlow({ s3Key: 'uploads/k' });
    renderComposer();
    const eleven = Array.from({ length: 11 }, (_, i) => imageFile(`f${i}.png`, 16));
    fireEvent.change(fileInput(), { target: { files: eleven } });
    expect(screen.getByRole('alert')).toHaveTextContent(/at most 10 files/i);
    // Only the first 10 were accepted + uploaded.
    expect(mockedPresign).toHaveBeenCalledTimes(10);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^Remove/ })).toHaveLength(10),
    );
  });

  it('rejects another file when the CONFIRMED deliverables already exceed the 5MB send total', async () => {
    // The total pre-check runs over confirmed (deliverable) sizes - source sizes
    // shrink at confirm, so counting a picked file's source bytes would falsely
    // reject auto-fit candidates. Two confirmed 3MB deliverables = 6MB > 5MB, so
    // the NEXT pick is refused (the server's send-time cap stays the backstop).
    mockedPresign.mockResolvedValue({ key: 'uploads/k', post: { url: 'u', fields: {} } });
    mockedS3Post.mockResolvedValue(undefined);
    mockedConfirm.mockResolvedValue({
      s3Key: 'uploads/k',
      contentType: 'image/png',
      size: 3 * 1024 * 1024,
      originalKey: 'uploads/k',
    });
    renderComposer();
    fireEvent.change(fileInput(), { target: { files: [imageFile('a.png', 1024)] } });
    await screen.findByRole('button', { name: 'Remove a.png' });
    fireEvent.change(fileInput(), { target: { files: [imageFile('b.png', 1024)] } });
    await screen.findByRole('button', { name: 'Remove b.png' });
    fireEvent.change(fileInput(), { target: { files: [imageFile('c.png', 1024)] } });
    expect(screen.getByRole('alert')).toHaveTextContent(/5 MB total limit/i);
    expect(mockedPresign).toHaveBeenCalledTimes(2); // c.png never uploaded
  });

  it('carries the rendition keys AND original keys to onSend alongside the body', async () => {
    mockedPresign.mockResolvedValue({ key: 'uploads/orig1', post: { url: 'u', fields: {} } });
    mockedS3Post.mockResolvedValue(undefined);
    mockedConfirm.mockResolvedValue({
      s3Key: 'uploads/deliv1',
      contentType: 'image/jpeg',
      size: 900,
      originalKey: 'uploads/orig1',
      transcodedFrom: 'image/webp',
    });
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer({ onSend });
    fireEvent.change(fileInput(), { target: { files: [imageFile('pic.webp', 2048, 'image/webp')] } });
    await screen.findByRole('button', { name: /Remove/ });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'see attached' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('see attached', ['uploads/deliv1'], ['uploads/orig1']);
    // Chips clear after a successful send.
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument(),
    );
  });

  it('enables Send with an attachment and NO body (body OR attachments)', async () => {
    mockUploadFlow({ s3Key: 'uploads/abc' });
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderComposer({ onSend });
    // Empty body, no attachment -> disabled.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(fileInput(), { target: { files: [imageFile()] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // Attachment-only send: onSend gets an empty body + the keys (flow-through:
    // original IS the rendition).
    expect(onSend).toHaveBeenCalledWith('', ['uploads/abc'], ['uploads/abc']);
    // Let the send resolve (chips clear) so no state update escapes act().
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument(),
    );
  });

  it('restores the chips when an attachment send fails (nothing lost)', async () => {
    mockUploadFlow({ s3Key: 'uploads/abc' });
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
    mockedPresign.mockResolvedValue({ key: 'uploads/good', post: { url: 'u', fields: {} } });
    mockedS3Post.mockResolvedValue(undefined);
    mockedConfirm
      .mockResolvedValueOnce({ s3Key: 'uploads/good', contentType: 'image/png', size: 2048, originalKey: 'uploads/good' })
      .mockRejectedValueOnce(new ApiError(400, 'transcode_failed', 'transcode_failed'));
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
    expect(onSend).toHaveBeenCalledWith('see attached', ['uploads/good'], ['uploads/good']);
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
    mockUploadFlow({ s3Key: 'uploads/abc' });
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
