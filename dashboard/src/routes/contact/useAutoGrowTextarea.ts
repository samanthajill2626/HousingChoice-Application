// useAutoGrowTextarea — grow a <textarea> to fit its content: one line by
// default, expanding as the user types up to the element's CSS max-height (then
// it scrolls). A MANUAL drag-resize takes precedence — once the user grabs the
// resize handle, auto-grow stops and keeps their chosen height. When the value is
// cleared (e.g. after a send), it resets to one line and re-arms auto-grow for the
// next message, so "manual override" is per-message, not forever.
//
// Pass the live `value` so the fit re-runs on every change (type / paste / clear).
import { useCallback, useEffect, useRef } from 'react';

export function useAutoGrowTextarea(value: string): React.RefObject<HTMLTextAreaElement | null> {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // The user has dragged the resize handle → respect their height (until clear).
  const manualRef = useRef(false);
  // The last height WE set, so the ResizeObserver can tell our own growth apart
  // from a manual drag (any height we didn't set).
  const autoHeightRef = useRef<number | null>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el || manualRef.current) return;
    el.style.height = 'auto'; // reset first so deletions reflow the box downward
    const cs = getComputedStyle(el);
    // scrollHeight is the padding-box content extent — it EXCLUDES borders. Under
    // box-sizing:border-box the height we set INCLUDES them, so add the borders
    // back; otherwise the box lands ~2px short and shows a phantom scrollbar (and
    // a tiny shrink) the moment content appears.
    const borderY =
      cs.boxSizing === 'border-box'
        ? (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
        : 0;
    const full = el.scrollHeight + borderY;
    const maxH = parseFloat(cs.maxHeight);
    const next = Number.isFinite(maxH) ? Math.min(full, maxH) : full;
    el.style.height = `${next}px`;
    autoHeightRef.current = el.offsetHeight;
  }, []);

  useEffect(() => {
    // Cleared (sent or emptied): drop any manual size so auto-grow re-arms for the
    // next message. Then fit() ALWAYS — including the empty state. Measuring the
    // empty box the same way (scrollHeight, an empty textarea = one line) as the
    // typed box keeps the placeholder height pixel-identical to the first
    // keystroke; using height:'auto' (the rows-based height) here instead rounds
    // ~1-2px differently and the box visibly shrinks on the first character.
    if (value === '') manualRef.current = false;
    fit();
  }, [value, fit]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      if (manualRef.current || autoHeightRef.current === null) return;
      // A height we didn't set → the user dragged the handle. Respect it from now.
      if (Math.abs(el.offsetHeight - autoHeightRef.current) > 1) manualRef.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return ref;
}
