// MediaGallery — the "Media from comms" grid for the contact file panes. A
// square thumbnail per image (opens the shared viewer), a glyph tile per
// non-image link (PDF/other). Fed by useContactMedia (the media pointer index, paged
// newest-first) so it shows EVERY attachment on the contact's threads, updates
// live as messages arrive, and walks older media through "Load older media"
// - a document is never out of reach because newer texts buried it.
import { Spinner } from '../../ui/index.js';
import { useImageViewer } from '../../ui/imageViewer/ImageViewerProvider.js';
import { EmptyRow } from './Card.js';
import { isInlineRenderable, isPdfMediaType, mediaKindWord, type CommsMediaItem } from './media.js';
import styles from './MediaGallery.module.css';

// Glyphs via String.fromCodePoint so these SOURCE LINES stay ASCII, matching
// Timeline.tsx. U+1F4C4 = page (PDF); U+1F4CE = paperclip (everything else).
const ICON_PAGE = String.fromCodePoint(0x1f4c4);
const ICON_CLIP = String.fromCodePoint(0x1f4ce);

/** What a paging caller supplies for the "Load older media" control (all three
 *  are one unit: `hasMore` renders it, `loadingMore` disables it, `onLoadMore` fetches). */
export interface MediaGalleryPaging {
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

function MediaImageButton({ item }: { item: CommsMediaItem }): React.JSX.Element {
  const { openImage } = useImageViewer();
  return (
    <button
      type="button"
      className={styles.tile}
      aria-label="View image attachment"
      aria-haspopup="dialog"
      onClick={(event) =>
        openImage(
          { src: item.src, alt: 'Image attachment', title: 'Image attachment' },
          event.currentTarget,
        )
      }
    >
      <img className={styles.img} src={item.src} alt="Image attachment" loading="lazy" />
    </button>
  );
}

export function MediaGallery({
  media,
  loading = false,
  paging,
}: {
  media: CommsMediaItem[];
  loading?: boolean;
  paging?: MediaGalleryPaging | undefined;
}): React.JSX.Element {
  if (media.length === 0) {
    return loading ? <Spinner /> : <EmptyRow>No media yet.</EmptyRow>;
  }
  return (
    <div>
      <div className={styles.grid}>
        {media.map((m) =>
          isInlineRenderable(m.contentType) ? (
            <MediaImageButton key={m.key} item={m} />
          ) : (
            <a
              key={m.key}
              className={styles.tile}
              href={m.src}
              target="_blank"
              rel="noopener noreferrer"
              title={mediaKindWord(m.contentType) ?? 'Attachment'}
            >
              <span className={styles.glyph} aria-hidden="true">
                {isPdfMediaType(m.contentType) ? ICON_PAGE : ICON_CLIP}
              </span>
            </a>
          ),
        )}
      </div>
      {paging !== undefined && paging.hasMore ? (
        <div className={styles.loadMore}>
          <button
            type="button"
            className={styles.loadMoreButton}
            onClick={paging.onLoadMore}
            disabled={paging.loadingMore}
          >
            {paging.loadingMore ? 'Loading...' : 'Load older media'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
