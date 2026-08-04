// twoPaneShell (behavior) - the TS half of the shared two-pane detail shell whose
// layout lives in twoPaneShell.module.css. The stylesheet hides the non-selected
// pane with `display: none` BELOW a single breakpoint; anything that must know
// whether a pane is actually on screen (not merely mounted) needs that same
// breakpoint in JS, so it is declared ONCE here and mirrored in the CSS.
//
// Why a component would care: a hidden pane is still MOUNTED and its effects
// still run. An effect with a side effect the operator is supposed to have
// "seen" (mark-read) must gate on visibility, or opening a page on a phone
// silently consumes state the operator never looked at.
import { useEffect, useState } from 'react';

/** The two-pane breakpoint. At/below this width the shell stacks into ONE column
 *  and the segmented Details/Conversation toggle picks which pane shows (the
 *  other gets `display: none` via `.paneHidden`); above it BOTH panes render and
 *  the toggle is inert. MIRROR THIS in twoPaneShell.module.css's media query. */
export const TWO_PANE_BREAKPOINT_PX = 860;

const NARROW_QUERY = `(max-width: ${TWO_PANE_BREAKPOINT_PX}px)`;

function matchesNarrow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

/**
 * True when the viewport is narrow enough that the shell shows ONE pane at a
 * time (so `pane` decides what is on screen). Tracked live via matchMedia, the
 * same pattern as app/useNavChrome + settings/useIsMobile. Feature-detects
 * matchMedia and degrades to the WIDE (two-pane, everything visible) reading,
 * which is the safe default: it never suppresses behavior a desktop operator
 * expects.
 */
export function useTwoPaneNarrow(): boolean {
  const [narrow, setNarrow] = useState(matchesNarrow);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => setNarrow(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return narrow;
}
