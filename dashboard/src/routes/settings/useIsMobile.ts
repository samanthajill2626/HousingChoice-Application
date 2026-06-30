// useIsMobile — true when the viewport is below the nav breakpoint, tracked
// live via matchMedia. Mirrors the responsive pattern in app/useNavChrome.ts
// (same NAV_BREAKPOINT_PX) so the Settings tabs↔dropdown switch lines up with
// the sidebar↔drawer switch. Feature-detects matchMedia (degrades to desktop).
import { useEffect, useState } from 'react';
import { NAV_BREAKPOINT_PX } from '../../app/useNavChrome.js';

const MOBILE_QUERY = `(max-width: ${NAV_BREAKPOINT_PX - 0.02}px)`;

function matchesMobile(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(matchesMobile);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (): void => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
