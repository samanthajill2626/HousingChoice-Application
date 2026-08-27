import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchContentRef,
} from 'react-zoom-pan-pinch';
import { Modal } from '../../routes/contact/Modal.js';
import { Spinner } from '../Spinner.js';
import type { ViewerImage } from './ImageViewerProvider.js';
import { fitImageToCanvas, type Size } from './fitImage.js';
import styles from './ImageViewer.module.css';

export interface ImageViewerProps {
  token: string;
  image: ViewerImage;
  onDismiss: (token: string) => void;
}

interface TransformState {
  scale: number;
  positionX: number;
  positionY: number;
}

interface Announcement {
  ownerKey: string;
  sequence: number;
  text: string;
}

interface MediaState {
  ownerKey: string;
  loadState: 'loading' | 'loaded' | 'error';
  naturalSize: Size;
}

interface OwnedTransformState extends TransformState {
  ownerKey: string;
}

interface PendingKeyboardCommand {
  id: number;
  ownerKey: string;
}

const EMPTY_SIZE: Size = { width: 0, height: 0 };
const INITIAL_TRANSFORM: TransformState = {
  scale: 1,
  positionX: 0,
  positionY: 0,
};

export function ImageViewer({ token, image, onDismiss }: ImageViewerProps): React.JSX.Element {
  const viewerKey = `${token}:${image.src}`;
  const instructionId = useId();
  const canvasRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<ReactZoomPanPinchContentRef>(null);
  const nextKeyboardCommandId = useRef(0);
  const pendingKeyboardCommand = useRef<PendingKeyboardCommand | null>(null);
  const [mediaState, setMediaState] = useState<MediaState>({
    ownerKey: viewerKey,
    loadState: 'loading',
    naturalSize: EMPTY_SIZE,
  });
  const [canvasSize, setCanvasSize] = useState<Size>(EMPTY_SIZE);
  const [ownedTransform, setOwnedTransform] = useState<OwnedTransformState>({
    ownerKey: '',
    ...INITIAL_TRANSFORM,
  });
  const [ownedAnnouncement, setOwnedAnnouncement] = useState<Announcement>({
    ownerKey: '',
    sequence: 0,
    text: '',
  });
  const dismiss = (): void => onDismiss(token);

  const loadState = mediaState.ownerKey === viewerKey ? mediaState.loadState : 'loading';
  const naturalSize = mediaState.ownerKey === viewerKey ? mediaState.naturalSize : EMPTY_SIZE;
  const fitted = useMemo(
    () => fitImageToCanvas(naturalSize, canvasSize),
    [canvasSize, naturalSize],
  );
  const transformKey = `${token}:${fitted.width}x${fitted.height}`;
  const hasPositiveGeometry =
    loadState === 'loaded' && fitted.width > 0 && fitted.height > 0;
  const transform =
    ownedTransform.ownerKey === transformKey ? ownedTransform : INITIAL_TRANSFORM;
  const announcement =
    ownedAnnouncement.ownerKey === transformKey
      ? ownedAnnouncement
      : { ownerKey: transformKey, sequence: 0, text: '' };

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const measure = (): void => {
      setCanvasSize({ width: canvas.clientWidth, height: canvas.clientHeight });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    measure();
    return () => observer.disconnect();
  }, []);

  const publishAnnouncement = useCallback((text: string): void => {
    setOwnedAnnouncement((current) => ({
      ownerKey: transformKey,
      sequence: current.ownerKey === transformKey ? current.sequence + 1 : 1,
      text,
    }));
  }, [transformKey]);

  const updateTransform = useCallback(
    (next: TransformState): void => {
      setOwnedTransform({
        ownerKey: transformKey,
        scale: next.scale,
        positionX: next.positionX,
        positionY: next.positionY,
      });
      if (pendingKeyboardCommand.current?.ownerKey !== transformKey) return;
      pendingKeyboardCommand.current = null;
      publishAnnouncement(`${Math.round(next.scale * 100)}%`);
    },
    [publishAnnouncement, transformKey],
  );

  const runKeyboardCommand = useCallback(
    (runControl: () => void): void => {
      const commandId = ++nextKeyboardCommandId.current;
      pendingKeyboardCommand.current = { id: commandId, ownerKey: transformKey };
      runControl();
      queueMicrotask(() => {
        if (
          pendingKeyboardCommand.current?.id !== commandId ||
          pendingKeyboardCommand.current.ownerKey !== transformKey
        ) {
          return;
        }
        pendingKeyboardCommand.current = null;
        const currentScale = transformRef.current?.state.scale ?? transform.scale;
        publishAnnouncement(`${Math.round(currentScale * 100)}%`);
      });
    },
    [publishAnnouncement, transform.scale, transformKey],
  );

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const controls = transformRef.current;
    if (controls === null) return;

    let runControl: (() => void) | undefined;
    if (event.key === '+' || event.key === '=') {
      runControl = () => controls.zoomIn(0.2, 0);
    } else if (event.key === '-') {
      runControl = () => controls.zoomOut(0.2, 0);
    } else if (event.key === '0') {
      runControl = () => controls.resetTransform(0);
    }
    if (runControl === undefined) return;

    event.preventDefault();
    runKeyboardCommand(runControl);
  };

  const handleProbeLoad = (event: React.SyntheticEvent<HTMLImageElement>): void => {
    const probe = event.currentTarget;
    const nextNaturalSize = {
      width: probe.naturalWidth,
      height: probe.naturalHeight,
    };
    if (nextNaturalSize.width <= 0 || nextNaturalSize.height <= 0) return;
    setMediaState({
      ownerKey: viewerKey,
      loadState: 'loaded',
      naturalSize: nextNaturalSize,
    });
  };

  const handleImageError = (): void => {
    setMediaState({
      ownerKey: viewerKey,
      loadState: 'error',
      naturalSize: EMPTY_SIZE,
    });
  };

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
      onDialogKeyDown={handleDialogKeyDown}
    >
      <div className={styles.viewer} data-image-viewer-root="true">
        <div
          ref={canvasRef}
          className={styles.canvas}
          data-image-viewer-canvas="true"
          aria-describedby={instructionId}
        >
          <img
            className={styles.probe}
            src={image.src}
            alt=""
            aria-hidden="true"
            data-image-viewer-probe="true"
            onLoad={handleProbeLoad}
            onError={handleImageError}
          />
          {loadState === 'loading' ? (
            <div className={styles.loading}>
              <Spinner label="Loading image" />
              <span>Loading image...</span>
            </div>
          ) : null}
          {loadState === 'error' ? (
            <p className={styles.failure}>This image could not be displayed.</p>
          ) : null}
          {hasPositiveGeometry ? (
            <TransformWrapper
              key={transformKey}
              ref={transformRef}
              initialScale={1}
              minScale={1}
              maxScale={8}
              smooth={false}
              disablePadding
              centerOnInit
              centerZoomedOut
              limitToBounds
              wheel={{ step: 0.2 }}
              pinch={{ step: 5, allowPanning: true }}
              panning={{ allowLeftClickPan: true }}
              doubleClick={{ disabled: true }}
              onTransform={(_ref, next) => updateTransform(next)}
            >
              <TransformComponent
                wrapperStyle={{ width: '100%', height: '100%' }}
                contentStyle={{ width: `${fitted.width}px`, height: `${fitted.height}px` }}
              >
                <img
                  className={styles.image}
                  src={image.src}
                  alt={image.alt}
                  draggable={false}
                  onError={handleImageError}
                />
              </TransformComponent>
            </TransformWrapper>
          ) : null}
          <p id={instructionId} className={styles.visuallyHidden}>
            Wheel or pinch to zoom; drag to pan. Keyboard: +, -, or 0 to reset.
          </p>
          <output
            aria-live="polite"
            aria-atomic="true"
            className={styles.visuallyHidden}
            data-image-viewer-scale={transform.scale.toFixed(3)}
            data-image-viewer-x={transform.positionX.toFixed(1)}
            data-image-viewer-y={transform.positionY.toFixed(1)}
          >
            <span key={announcement.sequence}>{announcement.text}</span>
          </output>
        </div>
      </div>
    </Modal>
  );
}
