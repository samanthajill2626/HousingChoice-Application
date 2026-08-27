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
    // The file tile is the other branch: a link titled with the true type.
    expect(screen.getByRole('link', { name: 'image/heic' })).toBeInTheDocument();
  });

  it('still renders a jpeg gallery item as an img', () => {
    renderGallery([item('image/jpeg')]);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });
});
