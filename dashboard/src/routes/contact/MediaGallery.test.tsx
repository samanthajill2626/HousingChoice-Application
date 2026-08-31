import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { MediaGallery } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';

const AT = '2026-08-01T00:00:00.000Z';
const item = (contentType: string): CommsMediaItem => ({
  key: 'a:0',
  src: '/x',
  contentType,
  at: AT,
});

function renderGallery(media: CommsMediaItem[]) {
  return render(
    <MemoryRouter>
      <MediaGallery media={media} />
    </MemoryRouter>,
  );
}

describe('MediaGallery type tiers', () => {
  it('renders a HEIC gallery item as a file tile, not an img', () => {
    renderGallery([item('image/heic')]);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // The file tile is the other branch. It is titled with the KIND WORD, not
    // the raw MIME type: an operator hovering a tile wants "Image", not
    // "image/heic". The bare type was what this assertion used to pin.
    expect(screen.getByRole('link', { name: 'Image' })).toBeInTheDocument();
  });

  it('titles an unrecognised tile generically rather than leaking the raw type', () => {
    renderGallery([item('application/octet-stream')]);
    expect(screen.getByRole('link', { name: 'Attachment' })).toBeInTheDocument();
  });

  it('draws the PDF glyph for a PARAMETERIZED pdf, agreeing with the server', () => {
    // The server essence-matches, so it serves this inline as a PDF. An exact
    // === comparison here drew the generic paperclip instead - two readers,
    // one object, different answers.
    renderGallery([item('application/pdf; charset=utf-8')]);
    const tile = screen.getByRole('link');
    expect(tile.textContent).toBe(String.fromCodePoint(0x1f4c4));
  });

  it('still renders a jpeg gallery item as an img', () => {
    renderGallery([item('image/jpeg')]);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});
