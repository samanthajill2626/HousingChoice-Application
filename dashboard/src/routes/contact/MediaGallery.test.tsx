import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ImageViewerProvider } from '../../ui/imageViewer/ImageViewerProvider.js';
import {
  installImageViewerResizeObserver,
  loadViewerImage,
} from '../../ui/imageViewer/ImageViewer.testUtils.js';
import { MediaGallery, type MediaGalleryPaging } from './MediaGallery.js';
import type { CommsMediaItem } from './media.js';

const MEDIA: CommsMediaItem[] = [
  {
    key: 'new-image',
    src: '/api/messages/MM2/media/0',
    contentType: 'image/png',
    at: '2026-08-27T12:00:00Z',
  },
  {
    key: 'old-image',
    src: '/api/messages/MM1/media/0',
    contentType: 'image/jpeg',
    at: '2026-08-26T12:00:00Z',
  },
  {
    key: 'document',
    src: '/api/messages/MM0/media/0',
    contentType: 'application/pdf',
    at: '2026-08-25T12:00:00Z',
  },
  {
    key: 'heic-image',
    src: '/api/messages/MMH/media/0',
    contentType: 'image/heic',
    at: '2026-08-24T12:00:00Z',
  },
];

function item(contentType: string): CommsMediaItem {
  return {
    key: 'single-item',
    src: '/api/messages/MMSINGLE/media/0',
    contentType,
    at: '2026-08-01T00:00:00.000Z',
  };
}

function gallery(
  media: CommsMediaItem[] = MEDIA,
  paging?: MediaGalleryPaging,
): React.JSX.Element {
  return (
    <MemoryRouter>
      <ImageViewerProvider>
        <MediaGallery media={media} paging={paging} />
      </ImageViewerProvider>
    </MemoryRouter>
  );
}

describe('MediaGallery type tiers', () => {
  it('renders a HEIC gallery item as a file tile, not an image trigger', () => {
    render(gallery([item('image/heic')]));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'image/heic' })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('renders a JPEG gallery item as an image trigger', () => {
    render(gallery([item('image/jpeg')]));
    expect(screen.getByRole('button', { name: 'View image attachment' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Image attachment' })).toBeInTheDocument();
  });
});

describe('MediaGallery image viewer integration', () => {
  it('preserves media order and opens eligible images one at a time while files stay links', async () => {
    const restoreResizeObserver = installImageViewerResizeObserver({ width: 1000, height: 600 });
    const user = userEvent.setup();
    try {
      render(gallery());

      const triggers = screen.getAllByRole('button', { name: 'View image attachment' });
      expect(triggers).toHaveLength(2);
      expect(
        triggers.map((trigger) =>
          within(trigger).getByRole('img', { name: 'Image attachment' }).getAttribute('src'),
        ),
      ).toEqual(['/api/messages/MM2/media/0', '/api/messages/MM1/media/0']);
      expect(triggers[0]).toHaveAttribute('aria-haspopup', 'dialog');
      expect(triggers[1]).toHaveAttribute('aria-haspopup', 'dialog');

      const fileLinks = screen.getAllByRole('link');
      expect(fileLinks.map((link) => link.getAttribute('href'))).toEqual([
        '/api/messages/MM0/media/0',
        '/api/messages/MMH/media/0',
      ]);
      for (const link of fileLinks) {
        expect(link).toHaveAttribute('target', '_blank');
      }

      await user.click(triggers[0]!);
      const firstDialog = screen.getByRole('dialog', { name: 'Image attachment' });
      const firstImage = await loadViewerImage(firstDialog, 'Image attachment');
      expect(firstImage).toHaveAttribute('src', '/api/messages/MM2/media/0');
      expect(
        within(firstDialog).queryByRole('button', { name: /Previous|Next/i }),
      ).not.toBeInTheDocument();

      await user.click(triggers[1]!);
      expect(screen.getByRole('dialog', { name: 'Image attachment' })).toBe(firstDialog);
      expect(firstImage).toHaveAttribute('src', '/api/messages/MM2/media/0');

      await user.click(within(firstDialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(triggers[0]).toHaveFocus();

      await user.click(triggers[1]!);
      const secondDialog = screen.getByRole('dialog', { name: 'Image attachment' });
      const secondImage = await loadViewerImage(secondDialog, 'Image attachment');
      expect(secondImage).toHaveAttribute('src', '/api/messages/MM1/media/0');
    } finally {
      restoreResizeObserver();
    }
  });

  it('keeps paging actionable and disables it while older media loads', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    const view = render(
      gallery(MEDIA, { hasMore: true, loadingMore: false, onLoadMore }),
    );

    const loadMore = screen.getByRole('button', { name: 'Load older media' });
    await user.click(loadMore);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    view.rerender(gallery(MEDIA, { hasMore: true, loadingMore: true, onLoadMore }));
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled();
  });
});
