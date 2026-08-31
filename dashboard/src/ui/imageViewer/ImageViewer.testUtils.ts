import { fireEvent, within } from '@testing-library/react';
import type { Size } from './fitImage.js';

export function installImageViewerResizeObserver(size: Size): () => void {
  const prior = globalThis.ResizeObserver;

  class PositiveResizeObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}

    observe(target: Element): void {
      Object.defineProperties(target, {
        clientWidth: { configurable: true, value: size.width },
        clientHeight: { configurable: true, value: size.height },
      });
      const contentRect = {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: size.width,
        bottom: size.height,
        width: size.width,
        height: size.height,
        toJSON: () => ({ width: size.width, height: size.height }),
      } as DOMRectReadOnly;
      this.callback(
        [{ target, contentRect } as ResizeObserverEntry],
        this,
      );
    }

    unobserve(): void {}

    disconnect(): void {}

    takeRecords(): ResizeObserverEntry[] {
      return [];
    }
  }

  globalThis.ResizeObserver = PositiveResizeObserver;
  return () => {
    globalThis.ResizeObserver = prior;
  };
}

export async function loadViewerImage(
  dialog: HTMLElement,
  alt: string,
  natural: Size = { width: 1200, height: 800 },
): Promise<HTMLImageElement> {
  const probe = dialog.querySelector<HTMLImageElement>('[data-image-viewer-probe="true"]');
  if (probe === null) {
    throw new Error('Image viewer probe was not found inside the supplied dialog');
  }
  Object.defineProperties(probe, {
    naturalWidth: { configurable: true, value: natural.width },
    naturalHeight: { configurable: true, value: natural.height },
  });
  fireEvent.load(probe);
  return within(dialog).findByRole('img', { name: alt });
}
