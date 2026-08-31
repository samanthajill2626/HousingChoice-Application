import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ImageViewer } from './ImageViewer.js';
import {
  installImageViewerResizeObserver,
  loadViewerImage,
} from './ImageViewer.testUtils.js';

interface TransformState {
  scale: number;
  positionX: number;
  positionY: number;
}

interface WrapperProps {
  children?: ReactNode;
  initialScale?: number;
  minScale?: number;
  maxScale?: number;
  smooth?: boolean;
  disablePadding?: boolean;
  centerOnInit?: boolean;
  centerZoomedOut?: boolean;
  limitToBounds?: boolean;
  wheel?: Record<string, unknown>;
  pinch?: Record<string, unknown>;
  panning?: Record<string, unknown>;
  doubleClick?: Record<string, unknown>;
  onTransform?: (ref: unknown, state: TransformState) => void;
}

interface ComponentProps {
  children?: ReactNode;
  wrapperStyle?: React.CSSProperties;
  contentStyle?: React.CSSProperties;
}

const zoomMock = vi.hoisted(() => ({
  wrapperProps: undefined as WrapperProps | undefined,
  componentProps: undefined as ComponentProps | undefined,
  currentState: { scale: 1, positionX: 0, positionY: 0 } as TransformState,
  activeInstance: 0,
  nextInstance: 0,
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  resetTransform: vi.fn(),
}));

vi.mock('react-zoom-pan-pinch', async () => {
  const React = await import('react');

  const TransformWrapper = React.forwardRef<unknown, WrapperProps>((props, ref) => {
    const [instance] = React.useState(() => ++zoomMock.nextInstance);
    const stateRef = React.useRef<TransformState>({
      scale: props.initialScale ?? 1,
      positionX: 0,
      positionY: 0,
    });
    zoomMock.wrapperProps = props;
    zoomMock.currentState = stateRef.current;
    zoomMock.activeInstance = instance;
    React.useImperativeHandle(
      ref,
      () => ({
        state: stateRef.current,
        zoomIn: zoomMock.zoomIn,
        zoomOut: zoomMock.zoomOut,
        resetTransform: zoomMock.resetTransform,
      }),
      [],
    );
    return (
      <div data-mock-transform-wrapper="true" data-mock-transform-instance={instance}>
        {props.children}
      </div>
    );
  });

  function TransformComponent(props: ComponentProps): React.JSX.Element {
    zoomMock.componentProps = props;
    return (
      <div
        data-mock-transform-component="true"
        style={props.wrapperStyle}
      >
        <div data-mock-transform-content="true" style={props.contentStyle}>
          {props.children}
        </div>
      </div>
    );
  }

  return { TransformWrapper, TransformComponent };
});

const IMAGE = {
  src: '/api/messages/MM1/media/0',
  alt: 'Front porch.jpg',
  title: 'Front porch.jpg',
};

let restoreResizeObserver: (() => void) | undefined;

function installCanvas(width = 1000, height = 600): void {
  restoreResizeObserver?.();
  restoreResizeObserver = installImageViewerResizeObserver({ width, height });
}

function renderViewer(token = 'viewer-1') {
  const onDismiss = vi.fn();
  const view = render(
    <ImageViewer token={token} image={IMAGE} onDismiss={onDismiss} />,
  );
  const dialog = screen.getByRole('dialog', { name: IMAGE.title });
  return { ...view, dialog, onDismiss };
}

function emitTransform(next: TransformState): void {
  Object.assign(zoomMock.currentState, next);
  act(() => {
    zoomMock.wrapperProps?.onTransform?.({ state: zoomMock.currentState }, next);
  });
}

async function flushMicrotask(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  zoomMock.wrapperProps = undefined;
  zoomMock.componentProps = undefined;
  zoomMock.currentState = { scale: 1, positionX: 0, positionY: 0 };
  zoomMock.activeInstance = 0;
  zoomMock.nextInstance = 0;
  zoomMock.resetTransform.mockImplementation(() => {
    Object.assign(zoomMock.currentState, { scale: 1, positionX: 0, positionY: 0 });
  });
});

afterEach(() => {
  restoreResizeObserver?.();
  restoreResizeObserver = undefined;
});

describe('ImageViewer', () => {
  it.each([
    [{ width: 2, height: 2 }, { width: '600px', height: '600px' }],
    [{ width: 4000, height: 2000 }, { width: '1000px', height: '500px' }],
    [{ width: 2000, height: 4000 }, { width: '300px', height: '600px' }],
  ])('fits the package content box to the image bitmap', async (natural, expectedStyle) => {
    installCanvas();
    const { dialog } = renderViewer();
    const root = dialog.querySelector('[data-image-viewer-root="true"]');
    const canvas = dialog.querySelector('[data-image-viewer-canvas="true"]');
    const loading = within(dialog).getByText('Loading image...');

    expect(root).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(root).not.toBe(canvas);
    expect(root).toContainElement(canvas as HTMLElement);
    expect(canvas).toContainElement(loading);
    expect(dialog.querySelectorAll('[data-image-viewer-root="true"]')).toHaveLength(1);
    expect(dialog.querySelectorAll('[data-image-viewer-canvas="true"]')).toHaveLength(1);
    expect(zoomMock.wrapperProps).toBeUndefined();

    const visibleImage = await loadViewerImage(dialog, IMAGE.alt, natural);

    expect(visibleImage).toHaveAttribute('src', IMAGE.src);
    expect(zoomMock.wrapperProps).toMatchObject({
      initialScale: 1,
      minScale: 1,
      maxScale: 8,
      smooth: false,
      disablePadding: true,
      centerOnInit: true,
      centerZoomedOut: true,
      limitToBounds: true,
      wheel: { step: 0.2 },
      pinch: { step: 5, allowPanning: true },
      panning: { allowLeftClickPan: true },
      doubleClick: { disabled: true },
    });
    expect(zoomMock.wrapperProps?.wheel).not.toHaveProperty('smooth');
    expect(zoomMock.wrapperProps?.pinch).not.toHaveProperty('disablePadding');
    expect(zoomMock.componentProps?.wrapperStyle).toEqual({ width: '100%', height: '100%' });
    expect(zoomMock.componentProps?.contentStyle).toEqual(expectedStyle);
  });

  it('renders only product chrome and describes the transform canvas', async () => {
    installCanvas();
    const { dialog } = renderViewer();
    await loadViewerImage(dialog, IMAGE.alt);

    expect(within(dialog).getAllByRole('button')).toEqual([
      within(dialog).getByRole('button', { name: 'Close' }),
    ]);
    expect(within(dialog).getAllByRole('link')).toEqual([
      within(dialog).getByRole('link', { name: 'Download' }),
    ]);
    for (const name of ['Zoom in', 'Zoom out', 'Reset', 'Previous', 'Next']) {
      expect(within(dialog).queryByRole('button', { name })).not.toBeInTheDocument();
    }
    const canvas = dialog.querySelector<HTMLElement>('[data-image-viewer-canvas="true"]');
    const descriptionId = canvas?.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    expect(dialog.querySelector(`#${descriptionId}`)).toHaveTextContent(
      'Wheel or pinch to zoom; drag to pan. Keyboard: +, -, or 0 to reset.',
    );
  });

  it('routes only unmodified zoom keys through the dialog and announces the resulting scale', async () => {
    installCanvas();
    const { dialog } = renderViewer();
    await loadViewerImage(dialog, IMAGE.alt);
    const output = dialog.querySelector<HTMLOutputElement>('[data-image-viewer-scale]');
    expect(output).toHaveAttribute('data-image-viewer-scale', '1.000');
    expect(output).toHaveAttribute('data-image-viewer-x', '0.0');
    expect(output).toHaveAttribute('data-image-viewer-y', '0.0');

    expect(fireEvent.keyDown(dialog, { key: '+' })).toBe(false);
    expect(zoomMock.zoomIn).toHaveBeenLastCalledWith(0.2, 0);
    emitTransform({ scale: 2.25, positionX: 34, positionY: -18 });
    await flushMicrotask();

    expect(output).toHaveAttribute('data-image-viewer-scale', '2.250');
    expect(output).toHaveAttribute('data-image-viewer-x', '34.0');
    expect(output).toHaveAttribute('data-image-viewer-y', '-18.0');
    expect(output).toHaveTextContent('225%');

    expect(fireEvent.keyDown(dialog, { key: '=' })).toBe(false);
    await flushMicrotask();
    expect(zoomMock.zoomIn).toHaveBeenCalledTimes(2);
    expect(fireEvent.keyDown(dialog, { key: '-' })).toBe(false);
    await flushMicrotask();
    expect(zoomMock.zoomOut).toHaveBeenCalledWith(0.2, 0);
    expect(fireEvent.keyDown(dialog, { key: '0' })).toBe(false);
    await flushMicrotask();
    expect(zoomMock.resetTransform).toHaveBeenCalledWith(0);

    const callCounts = {
      zoomIn: zoomMock.zoomIn.mock.calls.length,
      zoomOut: zoomMock.zoomOut.mock.calls.length,
      reset: zoomMock.resetTransform.mock.calls.length,
    };
    expect(fireEvent.keyDown(dialog, { key: '+', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(dialog, { key: '-', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(dialog, { key: '0', altKey: true })).toBe(true);
    expect(zoomMock.zoomIn).toHaveBeenCalledTimes(callCounts.zoomIn);
    expect(zoomMock.zoomOut).toHaveBeenCalledTimes(callCounts.zoomOut);
    expect(zoomMock.resetTransform).toHaveBeenCalledTimes(callCounts.reset);
  });

  it('replaces the atomic announcement child for repeated no-op reset commands', async () => {
    installCanvas();
    const { dialog } = renderViewer();
    await loadViewerImage(dialog, IMAGE.alt);
    const output = dialog.querySelector<HTMLOutputElement>('[data-image-viewer-scale]');
    if (output === null) throw new Error('scale diagnostics were not rendered');

    fireEvent.keyDown(dialog, { key: '0' });
    await flushMicrotask();
    const firstAnnouncement = output.firstElementChild;
    expect(firstAnnouncement).toHaveTextContent('100%');

    fireEvent.keyDown(dialog, { key: '0' });
    await flushMicrotask();
    const secondAnnouncement = output.firstElementChild;
    expect(secondAnnouncement).toHaveTextContent('100%');
    expect(secondAnnouncement).not.toBe(firstAnnouncement);

    emitTransform({ scale: 1.4, positionX: 12, positionY: -7 });
    await flushMicrotask();
    expect(output).toHaveAttribute('data-image-viewer-scale', '1.400');
    expect(output).toHaveAttribute('data-image-viewer-x', '12.0');
    expect(output).toHaveAttribute('data-image-viewer-y', '-7.0');
    expect(output.firstElementChild).toBe(secondAnnouncement);
    expect(output).toHaveTextContent('100%');
  });

  it('keeps Close and Download available while loading and after failure', () => {
    installCanvas();
    const { dialog, onDismiss } = renderViewer();
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const download = within(dialog).getByRole('link', { name: 'Download' });
    const probe = dialog.querySelector<HTMLImageElement>('[data-image-viewer-probe="true"]');
    expect(probe).not.toBeNull();
    expect(within(dialog).getByText('Loading image...')).toBeInTheDocument();
    expect(download).toHaveAttribute('href', IMAGE.src);
    expect(download).toHaveAttribute('download');
    expect(download).not.toHaveAttribute('target');

    fireEvent.error(probe as HTMLImageElement);

    expect(within(dialog).queryByText('Loading image...')).not.toBeInTheDocument();
    expect(within(dialog).getByText('This image could not be displayed.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Download' })).toBe(download);
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledWith('viewer-1');
  });

  it('starts a fresh fitted transform when the token changes', async () => {
    installCanvas();
    const { dialog, rerender } = renderViewer('viewer-1');
    await loadViewerImage(dialog, IMAGE.alt);
    const firstInstance = zoomMock.activeInstance;
    emitTransform({ scale: 3, positionX: 80, positionY: -40 });
    expect(dialog.querySelector('[data-image-viewer-scale]')).toHaveAttribute(
      'data-image-viewer-scale',
      '3.000',
    );

    rerender(<ImageViewer token="viewer-2" image={IMAGE} onDismiss={() => undefined} />);
    const nextDialog = screen.getByRole('dialog', { name: IMAGE.title });
    await loadViewerImage(nextDialog, IMAGE.alt);

    expect(zoomMock.activeInstance).not.toBe(firstInstance);
    expect(zoomMock.wrapperProps).toMatchObject({ initialScale: 1, centerOnInit: true });
    expect(nextDialog.querySelector('[data-image-viewer-scale]')).toHaveAttribute(
      'data-image-viewer-scale',
      '1.000',
    );
    expect(nextDialog.querySelector('[data-image-viewer-scale]')).toHaveAttribute(
      'data-image-viewer-x',
      '0.0',
    );
    expect(nextDialog.querySelector('[data-image-viewer-scale]')).toHaveAttribute(
      'data-image-viewer-y',
      '0.0',
    );
  });
});
