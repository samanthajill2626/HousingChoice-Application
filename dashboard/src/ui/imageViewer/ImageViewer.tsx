import { Modal } from '../../routes/contact/Modal.js';
import type { ViewerImage } from './ImageViewerProvider.js';
import styles from './ImageViewer.module.css';

export interface ImageViewerProps {
  token: string;
  image: ViewerImage;
  onDismiss: (token: string) => void;
}

export function ImageViewer({ token, image, onDismiss }: ImageViewerProps): React.JSX.Element {
  const dismiss = (): void => onDismiss(token);

  return (
    <Modal
      title={image.title ?? image.alt}
      variant="media"
      headerActions={
        <a href={image.src} download>
          Download
        </a>
      }
      trapFocus
      initialFocus="close"
      restoreFocus={false}
      onClose={dismiss}
    >
      <div className={styles.viewer} data-image-viewer-root="true">
        <div className={styles.canvas} data-image-viewer-canvas="true">
          <img
            className={styles.image}
            src={image.src}
            alt={image.alt}
            draggable={false}
          />
        </div>
      </div>
    </Modal>
  );
}
