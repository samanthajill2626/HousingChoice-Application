import { StrictMode, useEffect, useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';
import { addImageViewerMarker } from './history.js';
import {
  ImageViewerProvider,
  useImageViewer,
  type ImageViewerContextValue,
  type ViewerImage,
} from './ImageViewerProvider.js';
import {
  installImageViewerResizeObserver,
  loadViewerImage,
} from './ImageViewer.testUtils.js';

const CONTACT_PATH = '/contacts/tenant-1';
const IMAGE: ViewerImage = {
  src: '/api/messages/MM1/media/0',
  alt: 'Front porch.jpg',
  title: 'Front porch.jpg',
};

let latestOpenImage: ImageViewerContextValue['openImage'] | undefined;
let latestNavigate: ReturnType<typeof useNavigate> | undefined;
let removeSource: (() => void) | undefined;
let restoreResizeObserver: (() => void) | undefined;

function Destination(): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return <button ref={ref}>Destination focus</button>;
}

function ViewerHarness(): React.JSX.Element {
  const { openImage } = useImageViewer();
  const location = useLocation();
  const navigate = useNavigate();
  const [sourceVisible, setSourceVisible] = useState(true);
  latestOpenImage = openImage;
  latestNavigate = navigate;
  removeSource = () => setSourceVisible(false);

  if (location.pathname === '/other') return <Destination />;

  return (
    <>
      <output data-testid="route-state">{JSON.stringify(location.state)}</output>
      <output data-testid="location-key">{location.key}</output>
      <div data-testid="page-scroller" style={{ overflow: 'auto' }}>
        {sourceVisible ? (
          <div data-testid="timeline-scroller" style={{ overflow: 'auto' }}>
            <button
              type="button"
              onClick={(event) => openImage(IMAGE, event.currentTarget)}
            >
              View Front porch.jpg
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}

interface RenderedHarness {
  root: HTMLDivElement;
  siblingPortal: HTMLDivElement;
  unmount: () => void;
}

function seedEntry(state: unknown = { from: 'inbox' }): void {
  window.history.replaceState(
    { usr: state, key: 'contact-entry', idx: 0 },
    '',
    CONTACT_PATH,
  );
}

function renderHarness(): RenderedHarness {
  const root = document.createElement('div');
  root.id = 'root';
  root.dataset.viewerTestRoot = 'true';
  root.inert = false;
  document.body.append(root);

  const siblingPortal = document.createElement('div');
  siblingPortal.dataset.viewerTestSibling = 'true';
  siblingPortal.style.zIndex = '100';
  siblingPortal.inert = true;
  document.body.append(siblingPortal);

  const view = render(
    <StrictMode>
      <BrowserRouter>
        <ImageViewerProvider>
          <ViewerHarness />
        </ImageViewerProvider>
      </BrowserRouter>
    </StrictMode>,
    { container: root },
  );

  return { root, siblingPortal, unmount: view.unmount };
}

function makeScrollable(element: HTMLElement, top: number, left: number): void {
  element.style.overflowX = 'auto';
  element.style.overflowY = 'auto';
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 100 },
    clientWidth: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 900 },
    scrollWidth: { configurable: true, value: 700 },
  });
  element.scrollTop = top;
  element.scrollLeft = left;
}

function isInsideInertTree(element: HTMLElement | null): boolean {
  if (element === null) return false;
  return element.inert || isInsideInertTree(element.parentElement);
}

function installInertAwareFocus(): () => void {
  const nativeFocus = HTMLElement.prototype.focus;
  const focus = vi
    .spyOn(HTMLElement.prototype, 'focus')
    .mockImplementation(function inertAwareFocus(
      this: HTMLElement,
      options?: FocusOptions,
    ): void {
      if (isInsideInertTree(this)) return;
      const portal = document.body.querySelector<HTMLElement>(
        '[data-image-viewer-portal="true"]',
      );
      if (portal !== null && !portal.contains(this)) return;
      nativeFocus.call(this, options);
    });
  return () => focus.mockRestore();
}

async function traverseHistory(direction: 'back' | 'forward'): Promise<void> {
  await act(async () => {
    const popped = new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
    });
    window.history[direction]();
    await popped;
  });
}

async function openViewer(): Promise<{
  dialog: HTMLElement;
  trigger: HTMLButtonElement;
}> {
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', {
    name: 'View Front porch.jpg',
  }) as HTMLButtonElement;
  await user.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: 'Front porch.jpg' });
  return { dialog, trigger };
}

beforeEach(() => {
  restoreResizeObserver = installImageViewerResizeObserver({ width: 1000, height: 600 });
});

afterEach(() => {
  restoreResizeObserver?.();
  restoreResizeObserver = undefined;
  latestOpenImage = undefined;
  latestNavigate = undefined;
  removeSource = undefined;
  vi.restoreAllMocks();
  document.querySelectorAll('[data-viewer-test-root], [data-viewer-test-sibling]').forEach(
    (element) => element.remove(),
  );
  window.history.replaceState({ usr: null, key: 'test-reset', idx: 0 }, '', '/');
});

describe('ImageViewerProvider lifecycle', () => {
  it('releases background inertness before restoring focus to the trigger', async () => {
    seedEntry();
    const { root } = renderHarness();
    const restoreFocus = installInertAwareFocus();

    try {
      const { trigger } = await openViewer();
      expect(root.inert).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(root.inert).toBe(false);
      expect(trigger).toHaveFocus();
    } finally {
      restoreFocus();
    }
  });

  it('opens one same-URL media portal, preserves opaque state, and restores exact inert values', async () => {
    seedEntry({ from: 'inbox', selectedTab: 'comms' });
    const { root, siblingPortal } = renderHarness();
    const { dialog, trigger } = await openViewer();
    const triggerFocus = vi.spyOn(trigger, 'focus');

    expect(window.location.pathname).toBe(CONTACT_PATH);
    expect(window.history.state.idx).toBe(1);
    expect(JSON.stringify(window.history.state.usr)).not.toContain(IMAGE.src);
    expect(JSON.stringify(window.history.state.usr)).not.toContain(IMAGE.alt);
    expect(root.inert).toBe(true);
    expect(siblingPortal.inert).toBe(true);

    const portal = document.body.querySelector<HTMLElement>('[data-image-viewer-portal="true"]');
    expect(portal?.parentElement).toBe(document.body);
    expect(dialog.parentElement).toHaveAttribute('data-modal-variant', 'media');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const download = within(dialog).getByRole('link', { name: 'Download' });
    const image = await loadViewerImage(dialog, IMAGE.alt);
    expect(close).toHaveFocus();
    expect(download).toHaveAttribute('href', IMAGE.src);
    expect(download).toHaveAttribute('download');
    expect(download).not.toHaveAttribute('target');
    expect(image).not.toHaveAttribute('tabindex');

    act(() => latestOpenImage?.({ ...IMAGE, title: 'Ignored image' }, trigger));
    expect(window.history.state.idx).toBe(1);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(document.body.querySelector('[data-image-viewer-portal="true"]')).toBe(portal);

    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.history.state.idx).toBe(0);
    expect(window.history.state.usr).toStrictEqual({ from: 'inbox', selectedTab: 'comms' });
    expect(root.inert).toBe(false);
    expect(siblingPortal.inert).toBe(true);
    expect(portal).not.toBeInTheDocument();
    expect(triggerFocus).toHaveBeenCalledTimes(1);
    expect(triggerFocus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('reopens a retained descriptor on Forward and refreshes connected scroll snapshots', async () => {
    seedEntry();
    renderHarness();
    const page = screen.getByTestId('page-scroller');
    const timeline = screen.getByTestId('timeline-scroller');
    makeScrollable(page, 140, 9);
    makeScrollable(timeline, 420, 3);

    const { trigger } = await openViewer();
    const firstPortal = document.body.querySelector('[data-image-viewer-portal="true"]');
    page.scrollTop = 1;
    page.scrollLeft = 2;
    timeline.scrollTop = 4;
    timeline.scrollLeft = 5;

    await traverseHistory('back');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect([page.scrollTop, page.scrollLeft]).toEqual([140, 9]);
    expect([timeline.scrollTop, timeline.scrollLeft]).toEqual([420, 3]);

    page.scrollTop = 240;
    page.scrollLeft = 19;
    timeline.scrollTop = 520;
    timeline.scrollLeft = 13;
    await traverseHistory('forward');
    await screen.findByRole('dialog', { name: IMAGE.title });
    expect(document.body.querySelector('[data-image-viewer-portal="true"]')).toBe(firstPortal);

    page.scrollTop = 7;
    page.scrollLeft = 8;
    timeline.scrollTop = 10;
    timeline.scrollLeft = 11;
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect([page.scrollTop, page.scrollLeft]).toEqual([240, 19]);
    expect([timeline.scrollTop, timeline.scrollLeft]).toEqual([520, 13]);
    expect(trigger).toHaveFocus();
  });

  it('guards synchronous duplicate dismissals and contains media Escape from background listeners', async () => {
    seedEntry();
    renderHarness();
    const backgroundEscape = vi.fn();
    const listener = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') backgroundEscape();
    };
    document.addEventListener('keydown', listener);

    try {
      const { dialog } = await openViewer();
      const close = within(dialog).getByRole('button', { name: 'Close' });
      const backdrop = dialog.parentElement as HTMLElement;
      fireEvent.keyDown(close, { key: 'Escape' });
      fireEvent.mouseDown(backdrop);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(window.history.state.idx).toBe(0);
      expect(backgroundEscape).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(window.history.state.idx).toBe(0);
    } finally {
      document.removeEventListener('keydown', listener);
    }
  });

  it.each([
    ['record state', { from: 'inbox', selectedTab: 'comms' }],
    ['non-record state', 'legacy-state'],
  ])('normalizes an unknown marker in place once for %s', async (_label, priorState) => {
    window.history.replaceState(
      { usr: { from: 'prior' }, key: 'prior-entry', idx: 0 },
      '',
      CONTACT_PATH,
    );
    const marked = addImageViewerMarker(priorState, {
      token: 'unknown-token',
      returnLocationKey: 'prior-entry',
    });
    window.history.pushState(
      { usr: marked, key: 'unknown-entry', idx: 1 },
      '',
      CONTACT_PATH,
    );
    const popstate = vi.fn();
    window.addEventListener('popstate', popstate);

    try {
      renderHarness();
      await waitFor(() => expect(window.history.state.usr).toStrictEqual(priorState));
      expect(window.history.state.idx).toBe(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(popstate).not.toHaveBeenCalled();
      const normalizedKey = window.history.state.key;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(window.history.state.key).toBe(normalizedKey);

      await traverseHistory('back');
      expect(window.history.state.usr).toStrictEqual({ from: 'prior' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await traverseHistory('forward');
      expect(window.history.state.usr).toStrictEqual(priorState);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } finally {
      window.removeEventListener('popstate', popstate);
    }
  });

  it('cleans up without restoring old-route scroll or focus after independent navigation', async () => {
    seedEntry();
    const { root, siblingPortal } = renderHarness();
    const page = screen.getByTestId('page-scroller');
    const timeline = screen.getByTestId('timeline-scroller');
    makeScrollable(page, 140, 9);
    makeScrollable(timeline, 420, 3);
    const { trigger } = await openViewer();
    const triggerFocus = vi.spyOn(trigger, 'focus');
    page.scrollTop = 701;
    page.scrollLeft = 702;
    timeline.scrollTop = 703;
    timeline.scrollLeft = 704;

    act(() => latestNavigate?.('/other', { state: { destination: true } }));

    await screen.findByRole('button', { name: 'Destination focus' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect([page.scrollTop, page.scrollLeft]).toEqual([701, 702]);
    expect([timeline.scrollTop, timeline.scrollLeft]).toEqual([703, 704]);
    expect(triggerFocus).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Destination focus' })).toHaveFocus();
    expect(root.inert).toBe(false);
    expect(siblingPortal.inert).toBe(true);
  });

  it('skips disconnected source scroll owners and trigger focus on verified dismissal', async () => {
    seedEntry();
    renderHarness();
    const page = screen.getByTestId('page-scroller');
    const timeline = screen.getByTestId('timeline-scroller');
    makeScrollable(page, 140, 9);
    makeScrollable(timeline, 420, 3);
    const { trigger } = await openViewer();
    const triggerFocus = vi.spyOn(trigger, 'focus');

    act(() => removeSource?.());
    expect(trigger.isConnected).toBe(false);
    expect(timeline.isConnected).toBe(false);
    page.scrollTop = 1;
    page.scrollLeft = 2;
    timeline.scrollTop = 7;
    timeline.scrollLeft = 8;
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect([page.scrollTop, page.scrollLeft]).toEqual([140, 9]);
    expect([timeline.scrollTop, timeline.scrollLeft]).toEqual([7, 8]);
    expect(triggerFocus).not.toHaveBeenCalled();
  });

  it('truncates the old Forward descriptor when a new viewer opens after Back', async () => {
    seedEntry();
    renderHarness();
    await openViewer();
    await traverseHistory('back');
    const trigger = screen.getByRole('button', { name: 'View Front porch.jpg' });

    act(() =>
      latestOpenImage?.(
        { src: '/api/messages/MM2/media/0', alt: 'Kitchen.jpg', title: 'Kitchen.jpg' },
        trigger,
      ),
    );
    await screen.findByRole('dialog', { name: 'Kitchen.jpg' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await traverseHistory('forward');

    expect(await screen.findByRole('dialog', { name: 'Kitchen.jpg' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Front porch.jpg' })).not.toBeInTheDocument();
  });
});
