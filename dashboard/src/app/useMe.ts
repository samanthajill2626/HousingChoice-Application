// useMe — the current navigator's self view WITH the Voice Phase 1 fields
// (cell / cell_verified_at / inbound_voice_line), fetched from GET /api/users/me.
// The app-wide AuthContext.me (GET /auth/me) carries ONLY {userId,email,role} —
// it's the session identity, not the voice profile. This hook is the source of
// truth for "does the navigator have a VERIFIED cell" (gates the masked-call
// control) and for the self cell-verification section. Small + refetchable.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getVoiceMe, type MeUser } from '../api/index.js';

export type MeStatus = 'loading' | 'ready' | 'error';

export interface MeState {
  status: MeStatus;
  me: MeUser | undefined;
  /** True only when the navigator has a cell that PASSED verification (a
   *  non-empty cell_verified_at) — the gate for placing masked calls. */
  hasVerifiedCell: boolean;
  /** Re-probe /api/users/me (after a successful cell verification). */
  refresh: () => void;
  /** Apply a freshly-fetched self view in place (e.g. after verify-confirm). */
  setMe: (me: MeUser) => void;
}

/** True when the self view carries a verified cell (both a cell AND a
 *  cell_verified_at). Pure so the CallMenu gate can be unit-tested. */
export function hasVerifiedCell(me: MeUser | undefined): boolean {
  return (
    me !== undefined &&
    typeof me.cell === 'string' &&
    me.cell.length > 0 &&
    typeof me.cell_verified_at === 'string' &&
    me.cell_verified_at.length > 0
  );
}

export function useMe(): MeState {
  const [status, setStatus] = useState<MeStatus>('loading');
  const [me, setMeState] = useState<MeUser | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const user = await getVoiceMe(controller.signal);
      if (controller.signal.aborted) return;
      setMeState(user);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => {
    setStatus('loading');
    void load();
  }, [load]);

  const setMe = useCallback((next: MeUser) => {
    setMeState(next);
    setStatus('ready');
  }, []);

  return { status, me, hasVerifiedCell: hasVerifiedCell(me), refresh, setMe };
}
