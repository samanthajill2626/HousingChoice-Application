import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  addImageViewerMarker,
  readImageViewerMarker,
  removeImageViewerMarker,
  type ImageViewerMarker,
} from './history.js';
import {
  captureScrollOwners,
  restoreScrollOwners,
  type ScrollSnapshot,
} from './scroll.js';
import { ImageViewer } from './ImageViewer.js';

export interface ViewerImage {
  src: string;
  alt: string;
  title?: string;
}

export interface ImageViewerContextValue {
  openImage: (image: ViewerImage, trigger: HTMLElement) => void;
}

interface RegistryEntry {
  image: ViewerImage;
  trigger: HTMLElement;
  scroll: ScrollSnapshot[];
}

interface ActiveViewer {
  marker: ImageViewerMarker;
  entry: RegistryEntry;
}

interface InertSnapshot {
  element: HTMLElement;
  inert: boolean;
}

const MAX_RETAINED_IMAGES = 20;
const ImageViewerContext = createContext<ImageViewerContextValue | undefined>(undefined);

function trimRegistry(registry: Map<string, RegistryEntry>, protectedToken: string): void {
  while (registry.size > MAX_RETAINED_IMAGES) {
    const oldestEvictable = Array.from(registry.keys()).find(
      (token) => token !== protectedToken,
    );
    if (oldestEvictable === undefined) return;
    registry.delete(oldestEvictable);
  }
}

export function ImageViewerProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const [registry, setRegistry] = useState(() => new Map<string, RegistryEntry>());
  const dismissRequestedRef = useRef(new Set<string>());
  const normalizedMarkersRef = useRef(new Set<string>());
  const previousActiveRef = useRef<ActiveViewer | undefined>(undefined);
  const releasePortalRef = useRef<(() => void) | undefined>(undefined);
  const [portalNode] = useState(() => {
    const node = document.createElement('div');
    node.dataset.imageViewerPortal = 'true';
    return node;
  });

  const marker = useMemo(() => readImageViewerMarker(location.state), [location.state]);
  const entry = marker === undefined ? undefined : registry.get(marker.token);
  const active = useMemo(
    () => (marker !== undefined && entry !== undefined ? { marker, entry } : undefined),
    [entry, marker],
  );

  const openImage = useCallback(
    (image: ViewerImage, trigger: HTMLElement): void => {
      if (readImageViewerMarker(location.state) !== undefined) return;

      const token = crypto.randomUUID();
      setRegistry((current) => {
        const next = new Map(current);
        next.set(token, {
          image,
          trigger,
          scroll: captureScrollOwners(trigger),
        });
        trimRegistry(next, token);
        return next;
      });
      navigate(
        {
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
        },
        {
          replace: false,
          state: addImageViewerMarker(location.state, {
            token,
            returnLocationKey: location.key,
          }),
        },
      );
    },
    [location, navigate],
  );

  const requestDismiss = useCallback(
    (token: string): void => {
      const currentMarker = readImageViewerMarker(location.state);
      if (
        currentMarker?.token !== token ||
        dismissRequestedRef.current.has(token)
      ) {
        return;
      }
      dismissRequestedRef.current.add(token);
      navigate(-1);
    },
    [location.state, navigate],
  );

  useLayoutEffect(() => {
    for (const token of dismissRequestedRef.current) {
      if (marker?.token !== token) dismissRequestedRef.current.delete(token);
    }
  }, [marker?.token]);

  useLayoutEffect(() => {
    if (marker === undefined || entry !== undefined) return;
    const normalizationKey = `${location.key}:${marker.token}`;
    if (normalizedMarkersRef.current.has(normalizationKey)) return;
    normalizedMarkersRef.current.add(normalizationKey);
    navigate(
      {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      {
        replace: true,
        state: removeImageViewerMarker(location.state),
      },
    );
  }, [entry, location.hash, location.key, location.pathname, location.search, location.state, marker, navigate]);

  useLayoutEffect(() => {
    const previous = previousActiveRef.current;
    if (active !== undefined) {
      const refreshedEntry =
        previous?.marker.token !== active.marker.token && active.entry.trigger.isConnected
          ? { ...active.entry, scroll: captureScrollOwners(active.entry.trigger) }
          : active.entry;
      previousActiveRef.current = { marker: active.marker, entry: refreshedEntry };
      return;
    }

    if (previous === undefined) return;
    previousActiveRef.current = undefined;
    if (location.key !== previous.marker.returnLocationKey) return;
    releasePortalRef.current?.();
    restoreScrollOwners(previous.entry.scroll);
    if (previous.entry.trigger.isConnected) {
      previous.entry.trigger.focus({ preventScroll: true });
    }
  }, [active, location.key]);

  const activeToken = active?.marker.token;
  useLayoutEffect(() => {
    if (activeToken === undefined) return;

    document.body.append(portalNode);
    const snapshots: InertSnapshot[] = Array.from(document.body.children)
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element !== portalNode,
      )
      .map((element) => ({ element, inert: element.inert }));
    for (const snapshot of snapshots) snapshot.element.inert = true;

    let released = false;
    const releasePortal = (): void => {
      if (released) return;
      released = true;
      for (const snapshot of snapshots) snapshot.element.inert = snapshot.inert;
      portalNode.remove();
    };
    releasePortalRef.current = releasePortal;

    return () => {
      releasePortal();
      if (releasePortalRef.current === releasePortal) releasePortalRef.current = undefined;
    };
  }, [activeToken, portalNode]);

  const value = useMemo<ImageViewerContextValue>(() => ({ openImage }), [openImage]);

  return (
    <ImageViewerContext.Provider value={value}>
      {children}
      {active !== undefined
        ? createPortal(
            <ImageViewer
              key={active.marker.token}
              token={active.marker.token}
              image={active.entry.image}
              onDismiss={requestDismiss}
            />,
            portalNode,
          )
        : null}
    </ImageViewerContext.Provider>
  );
}

export function useImageViewer(): ImageViewerContextValue {
  const context = useContext(ImageViewerContext);
  if (context === undefined) {
    throw new Error('useImageViewer must be used within ImageViewerProvider');
  }
  return context;
}
