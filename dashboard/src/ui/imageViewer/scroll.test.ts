import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureScrollOwners, restoreScrollOwners } from './scroll.js';

const originalScrollingElement = Object.getOwnPropertyDescriptor(document, 'scrollingElement');

function setScrollingElement(element: Element | null): void {
  Object.defineProperty(document, 'scrollingElement', {
    configurable: true,
    value: element,
  });
}

function setScrollGeometry(
  element: HTMLElement,
  geometry: {
    top: number;
    left: number;
    scrollHeight: number;
    clientHeight: number;
    scrollWidth: number;
    clientWidth: number;
  },
): void {
  Object.defineProperties(element, {
    scrollTop: { configurable: true, writable: true, value: geometry.top },
    scrollLeft: { configurable: true, writable: true, value: geometry.left },
    scrollHeight: { configurable: true, value: geometry.scrollHeight },
    clientHeight: { configurable: true, value: geometry.clientHeight },
    scrollWidth: { configurable: true, value: geometry.scrollWidth },
    clientWidth: { configurable: true, value: geometry.clientWidth },
  });
}

function stubOverflow(
  values: ReadonlyMap<Element, { overflowX?: string; overflowY?: string }>,
): void {
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const overflow = values.get(element);
    return {
      overflowX: overflow?.overflowX ?? 'visible',
      overflowY: overflow?.overflowY ?? 'visible',
    } as CSSStyleDeclaration;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  if (originalScrollingElement === undefined) {
    Reflect.deleteProperty(document, 'scrollingElement');
  } else {
    Object.defineProperty(document, 'scrollingElement', originalScrollingElement);
  }
});

describe('captureScrollOwners', () => {
  it('captures nested owners with independently scrollable axes and the document once', () => {
    const page = document.createElement('div');
    const stream = document.createElement('div');
    const trigger = document.createElement('button');
    page.append(stream);
    stream.append(trigger);
    document.body.append(page);

    setScrollGeometry(page, {
      top: 140,
      left: 9,
      scrollHeight: 900,
      clientHeight: 300,
      scrollWidth: 300,
      clientWidth: 300,
    });
    setScrollGeometry(stream, {
      top: 420,
      left: 3,
      scrollHeight: 200,
      clientHeight: 200,
      scrollWidth: 700,
      clientWidth: 250,
    });
    setScrollGeometry(document.documentElement, {
      top: 27,
      left: 5,
      scrollHeight: 1000,
      clientHeight: 600,
      scrollWidth: 800,
      clientWidth: 800,
    });
    setScrollingElement(document.documentElement);
    stubOverflow(
      new Map([
        [page, { overflowY: 'auto' }],
        [stream, { overflowX: 'overlay' }],
        [document.documentElement, { overflowY: 'scroll' }],
      ]),
    );

    const snapshots = captureScrollOwners(trigger);

    expect(snapshots).toStrictEqual([
      { element: stream, top: 420, left: 3 },
      { element: page, top: 140, left: 9 },
      { element: document.documentElement, top: 27, left: 5 },
    ]);
  });

  it('does not capture disconnected ancestor lookalikes', () => {
    const owner = document.createElement('div');
    const trigger = document.createElement('button');
    owner.append(trigger);
    setScrollGeometry(owner, {
      top: 80,
      left: 2,
      scrollHeight: 500,
      clientHeight: 100,
      scrollWidth: 100,
      clientWidth: 100,
    });
    setScrollGeometry(document.documentElement, {
      top: 10,
      left: 0,
      scrollHeight: 600,
      clientHeight: 600,
      scrollWidth: 800,
      clientWidth: 800,
    });
    setScrollingElement(document.documentElement);
    stubOverflow(new Map([[owner, { overflowY: 'auto' }]]));

    expect(captureScrollOwners(trigger)).toStrictEqual([
      { element: document.documentElement, top: 10, left: 0 },
    ]);
  });
});

describe('restoreScrollOwners', () => {
  it('restores exact x and y for every still-connected owner', () => {
    const page = document.createElement('div');
    const stream = document.createElement('div');
    const trigger = document.createElement('button');
    page.append(stream);
    stream.append(trigger);
    document.body.append(page);
    setScrollGeometry(page, {
      top: 140,
      left: 9,
      scrollHeight: 900,
      clientHeight: 300,
      scrollWidth: 500,
      clientWidth: 300,
    });
    setScrollGeometry(stream, {
      top: 420,
      left: 3,
      scrollHeight: 800,
      clientHeight: 200,
      scrollWidth: 700,
      clientWidth: 250,
    });
    setScrollingElement(document.documentElement);
    stubOverflow(
      new Map([
        [page, { overflowX: 'auto', overflowY: 'auto' }],
        [stream, { overflowX: 'scroll', overflowY: 'scroll' }],
      ]),
    );
    const snapshots = captureScrollOwners(trigger);

    page.scrollTop = 1;
    page.scrollLeft = 2;
    stream.scrollTop = 3;
    stream.scrollLeft = 4;
    restoreScrollOwners(snapshots);

    expect({ top: page.scrollTop, left: page.scrollLeft }).toStrictEqual({ top: 140, left: 9 });
    expect({ top: stream.scrollTop, left: stream.scrollLeft }).toStrictEqual({
      top: 420,
      left: 3,
    });
  });

  it('skips owners that disconnected after capture', () => {
    const owner = document.createElement('div');
    const trigger = document.createElement('button');
    owner.append(trigger);
    document.body.append(owner);
    setScrollGeometry(owner, {
      top: 90,
      left: 7,
      scrollHeight: 900,
      clientHeight: 200,
      scrollWidth: 700,
      clientWidth: 200,
    });
    setScrollingElement(document.documentElement);
    stubOverflow(new Map([[owner, { overflowX: 'auto', overflowY: 'auto' }]]));
    const snapshots = captureScrollOwners(trigger);

    owner.remove();
    owner.scrollTop = 11;
    owner.scrollLeft = 12;
    restoreScrollOwners(snapshots);

    expect({ top: owner.scrollTop, left: owner.scrollLeft }).toStrictEqual({ top: 11, left: 12 });
  });
});
