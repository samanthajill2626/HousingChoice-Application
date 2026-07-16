import { describe, it, expect, vi } from 'vitest';
import { resolveAttachmentKeys } from '../src/routes/api.js';
import type { MediaStore } from '../src/adapters/mediaStore.js';

function store(byKey: Record<string, { contentType: string; size: number }>): MediaStore {
  return { head: vi.fn(async (k: string) => byKey[k]) } as unknown as MediaStore;
}

describe('resolveAttachmentKeys deliverable guard', () => {
  it('rejects a non-deliverable stored type (webp reaching send)', async () => {
    const s = store({ 'uploads/aaaaaaaa-0000-0000-0000-000000000000': { contentType: 'image/webp', size: 100 } });
    const out = await resolveAttachmentKeys(['uploads/aaaaaaaa-0000-0000-0000-000000000000'], undefined, s);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('unsupported_attachment_type');
  });
  it('accepts a jpeg and carries originalKey', async () => {
    const s = store({ 'uploads/bbbbbbbb-0000-0000-0000-000000000000': { contentType: 'image/jpeg', size: 100 } });
    const out = await resolveAttachmentKeys(
      ['uploads/bbbbbbbb-0000-0000-0000-000000000000'],
      ['uploads/0e161000-0000-0000-0000-000000000000'],
      s,
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.attachments[0]).toMatchObject({ s3Key: 'uploads/bbbbbbbb-0000-0000-0000-000000000000', contentType: 'image/jpeg', originalKey: 'uploads/0e161000-0000-0000-0000-000000000000' });
  });
  it('rejects a forged originalKey outside the own uploads/ prefix', async () => {
    const s = store({ 'uploads/bbbbbbbb-0000-0000-0000-000000000000': { contentType: 'image/jpeg', size: 100 } });
    const out = await resolveAttachmentKeys(
      ['uploads/bbbbbbbb-0000-0000-0000-000000000000'],
      ['media/other-conversation/SMx/0'],
      s,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('invalid_attachment_key');
  });
  it('rejects originalKeys that are not index-aligned with keys', async () => {
    const s = store({ 'uploads/bbbbbbbb-0000-0000-0000-000000000000': { contentType: 'image/jpeg', size: 100 } });
    const out = await resolveAttachmentKeys(
      ['uploads/bbbbbbbb-0000-0000-0000-000000000000'],
      ['uploads/0e161000-0000-0000-0000-000000000000', 'uploads/0e161000-0000-0000-0000-000000000001'],
      s,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('invalid_attachment_key');
  });
});
