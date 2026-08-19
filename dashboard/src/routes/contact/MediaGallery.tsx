// MediaGallery — the "Media from comms" grid for the contact file panes. A
// square thumbnail per image (links to the full-size media), a glyph tile per
// non-image (PDF/other). Fed by useContactMedia (the media pointer index, paged
// newest-first) so it shows EVERY attachment on the contact's threads, updates
// live as messages arrive, and walks older media through "Load older media"
// - a document is never out of reach because newer texts buried it.
import { Spinner } from '../../ui/index.js';
import { EmptyRow } from './Card.js';
import type { CommsMediaItem } from './media.js';
import styles from './MediaGallery.module.css';

/** What a paging caller supplies for the "Load older media" control (all three
 *  are one unit: `hasMore` renders it, `loadingMore` disables it, `onLoadMore` fetches). */
export interface MediaGalleryPaging {
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
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
          m.contentType.startsWith('image/') ? (
            <a
              key={m.key}
              className={styles.tile}
              href={m.src}
              target="_blank"
              rel="noopener noreferrer"
            >
              <img className={styles.img} src={m.src} alt="Attachment" loading="lazy" />
            </a>
          ) : (
            <a
              key={m.key}
              className={styles.tile}
              href={m.src}
              target="_blank"
              rel="noopener noreferrer"
              title={m.contentType}
            >
              <span className={styles.glyph} aria-hidden="true">
                {m.contentType === 'application/pdf' ? '📄' : '📎'}
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
