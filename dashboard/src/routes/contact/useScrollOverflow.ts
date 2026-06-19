// useScrollOverflow — reports whether a scroll container is actually overflowing
// (vertical scrollbar present). CSS has no "has-scrollbar" selector, so callers
// use this to add gutter padding ONLY when a scrollbar is taking space — without
// one, that padding is just dead gutter.
//
// Two triggers, because neither alone is enough:
//   • `deps` — re-measure when content that changes height changes (cards loading,
//     media arriving, pane toggling). A ResizeObserver on the container does NOT
//     fire for this: the container's own border-box is fixed by the flex layout;
//     only its scrollHeight grows.
//   • ResizeObserver on the container — catches viewport/container resizes that
//     don't re-render (width reflow, height changes).
// padding-right is horizontal, so toggling it never changes scrollHeight/
// clientHeight → no measure/flip oscillation.
import { useLayoutEffect, useRef, useState } from 'react';

export function useScrollOverflow<T extends HTMLElement>(deps: unknown[]): {
  ref: React.RefObject<T | null>;
  overflowing: boolean;
} {
  const ref = useRef<T | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      // +1 absorbs sub-pixel rounding (scrollHeight is integer-rounded).
      const has = el.scrollHeight > el.clientHeight + 1;
      setOverflowing((prev) => (prev === has ? prev : has));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, overflowing };
}
