export interface ScrollSnapshot {
  element: HTMLElement;
  top: number;
  left: number;
}

const SCROLLABLE_OVERFLOW = /auto|scroll|overlay/;

function isScrollable(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const scrollsHorizontally =
    SCROLLABLE_OVERFLOW.test(style.overflowX) && element.scrollWidth > element.clientWidth;
  const scrollsVertically =
    SCROLLABLE_OVERFLOW.test(style.overflowY) && element.scrollHeight > element.clientHeight;
  return scrollsHorizontally || scrollsVertically;
}

export function captureScrollOwners(trigger: HTMLElement): ScrollSnapshot[] {
  const snapshots: ScrollSnapshot[] = [];
  const seen = new Set<HTMLElement>();

  const add = (element: HTMLElement): void => {
    if (!element.isConnected || seen.has(element)) return;
    seen.add(element);
    snapshots.push({ element, top: element.scrollTop, left: element.scrollLeft });
  };

  let ancestor = trigger.parentElement;
  while (ancestor !== null) {
    if (ancestor.isConnected && isScrollable(ancestor)) add(ancestor);
    if (ancestor === document.documentElement) break;
    ancestor = ancestor.parentElement;
  }

  const documentScroller = document.scrollingElement;
  if (documentScroller instanceof HTMLElement) add(documentScroller);

  return snapshots;
}

export function restoreScrollOwners(snapshots: readonly ScrollSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (!snapshot.element.isConnected) continue;
    snapshot.element.scrollTop = snapshot.top;
    snapshot.element.scrollLeft = snapshot.left;
  }
}
