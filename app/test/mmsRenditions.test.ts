import { describe, it, expect } from 'vitest';
import { renditionFor } from '../src/lib/mmsRenditions.js';

describe('renditionFor', () => {
  it('mms returns the delivered rendition key (s3Key)', () => {
    expect(renditionFor('mms', { s3Key: 'uploads/deliv', contentType: 'image/jpeg', originalKey: 'uploads/orig' }))
      .toEqual({ s3Key: 'uploads/deliv' });
  });
  it('mms works when there is no separate original (flow-through)', () => {
    expect(renditionFor('mms', { s3Key: 'uploads/gif', contentType: 'image/gif' }))
      .toEqual({ s3Key: 'uploads/gif' });
  });
});
