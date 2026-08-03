// useAutoGrowTextarea — grow a <textarea> to fit its content: one line by
// default, expanding as the user types up to the element's CSS max-height (then
// it scrolls). A MANUAL drag-resize takes precedence — once the user grabs the
// resize handle, auto-grow stops and keeps their chosen height. When the value is
// cleared (e.g. after a send), it resets to one line and re-arms auto-grow for the
// next message, so "manual override" is per-message, not forever.
//
// Pass the live `value` so the fit re-runs on every change (type / paste / clear).
//
// HIDDEN PANES: the composer also mounts inside panes that are display:none at
// narrow widths (twoPaneShell's `.paneHidden` behind the Details/Conversation
// toggle — tour, placement, contact, conversation). A box with no layout reports
// scrollHeight 0, so measuring one is meaningless: fitting on it collapsed the
// textarea to just its borders, and the ResizeObserver then read the reveal as a
// drag and disarmed auto-grow for the whole message — a long reply stayed clipped
// in that sliver. So we skip the fit while there's no box and do it on reveal.
import { useCallback, useEffect, useRef } from 'react';

/** True when the element is actually laid out. A textarea always has SOME height
 *  (its own padding + borders), so a 0 here means an ancestor is display:none —
 *  the only case where the browser's size readings are unusable. */
function hasLayoutBox(el: HTMLTextAreaElement): boolean {
  return el.scrollHeight > 0;
}

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
    const prev = el.style.height;
    el.style.height = 'auto'; // reset first so deletions reflow the box downward
    // No layout box (a display:none ancestor — the hidden mobile pane): every
    // measurement below would read 0 and collapse the box. Put back whatever
    // height it had and leave autoHeightRef untouched, so the observer knows this
    // element has never been measured and fits it once it's shown.
    if (!hasLayoutBox(el)) {
      el.style.height = prev;
      return;
    }
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
      if (manualRef.current) return;
      // Losing the box (the pane was hidden) reports 0x0. That's not a drag, and
      // there's nothing to measure — wait for it to come back.
      if (!hasLayoutBox(el)) return;
      // Never measured: we mounted inside a hidden pane and skipped the fit. This
      // callback IS the reveal, so do that fit now rather than mistake the
      // 0 → laid-out jump for a drag (which would disarm auto-grow entirely).
      if (autoHeightRef.current === null) {
        fit();
        return;
      }
      // A height we didn't set → the user dragged the handle. Respect it from now.
      if (Math.abs(el.offsetHeight - autoHeightRef.current) > 1) manualRef.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  return ref;
}
