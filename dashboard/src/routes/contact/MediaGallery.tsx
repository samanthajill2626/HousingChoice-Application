// MediaGallery — the "Media from comms" grid for the contact file panes. A
// square thumbnail per image (links to the full-size media), a glyph tile per
// non-image (PDF/other). Fed by commsMedia(timeline) so it reflects exactly the
// attachments in the comms pane and updates live as messages arrive.
import { Spinner } from '../../ui/index.js';
import { EmptyRow } from './Card.js';
import type { CommsMediaItem } from './media.js';
import styles from './MediaGallery.module.css';

export function MediaGallery({
  media,
  loading = false,
}: {
  media: CommsMediaItem[];
  loading?: boolean;
}): React.JSX.Element {
  if (media.length === 0) {
    return loading ? <Spinner /> : <EmptyRow>No media yet.</EmptyRow>;
  }
  return (
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
  );
}
