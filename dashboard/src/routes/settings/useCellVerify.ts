// useCellVerify — the self-service cell-verification state machine for the Voice
// section (Voice Phase 1 §7). Any logged-in user attaches + verifies their OWN
// cell (their outbound masked-call bridge leg). Two steps: verify-start (SMS a
// 6-digit code) → verify-confirm (stamp cell_verified_at). Maps the backend guard
// codes (invalid_cell / sms_unavailable / rate_limited / invalid_code /
// code_expired / too_many_attempts) to clear inline messages. Refetches the self view on success
// so the section shows the verified cell + timestamp.
import { useCallback, useState } from 'react';
import { ApiError, confirmCellVerify, startCellVerify, type MeUser } from '../../api/index.js';

/** The verification flow phase. `idle` before any attempt; `code_sent` after a
 *  successful verify-start (the code input shows); `verified` after confirm. */
export type VerifyPhase = 'idle' | 'code_sent' | 'verified';

export interface CellVerifyState {
  phase: VerifyPhase;
  busy: boolean;
  /** Inline error (role="alert"), or null. */
  error: string | null;
  /** The cell the code was sent to (echoed while entering the code). */
  pendingCell: string | null;
  /** Send a 6-digit code to `cell`. Returns true on success. */
  sendCode: (cell: string) => Promise<boolean>;
  /** Confirm the code; on success returns the verified cell_verified_at. */
  confirm: (code: string) => Promise<string | null>;
  /** Reset to idle (e.g. "use a different number"). */
  reset: () => void;
}

/** Map a verify-start error code to a friendly inline message. */
function startMessage(code: string): string {
  if (code === 'invalid_cell') return "That doesn't look like a valid US mobile number.";
  if (code === 'sms_unavailable') {
    return 'Texting is temporarily unavailable — try again in a moment.';
  }
  if (code === 'rate_limited') {
    return 'Too many codes requested — wait a few minutes and try again.';
  }
  return "Couldn't send the code — please try again.";
}

/** Map a verify-confirm error code to a friendly inline message. */
function confirmMessage(code: string): string {
  if (code === 'invalid_code') return "That code isn't right — check it and try again.";
  if (code === 'code_expired') return 'That code expired — send a new one.';
  if (code === 'too_many_attempts') return 'Too many attempts — wait a bit and send a new code.';
  return "Couldn't verify the code — please try again.";
}

export interface UseCellVerifyOptions {
  /** Called with the fresh self view after a successful confirm (so the parent
   *  can update its `me` in place). */
  onVerified?: (cellVerifiedAt: string) => void;
}

export function useCellVerify(options: UseCellVerifyOptions = {}): CellVerifyState {
  const { onVerified } = options;
  const [phase, setPhase] = useState<VerifyPhase>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCell, setPendingCell] = useState<string | null>(null);

  const sendCode = useCallback(async (cell: string): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await startCellVerify(cell);
      setPendingCell(cell);
      setPhase('code_sent');
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? startMessage(err.code) : "Couldn't send the code — please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const confirm = useCallback(
    async (code: string): Promise<string | null> => {
      if (busy) return null;
      setBusy(true);
      setError(null);
      try {
        const { cell_verified_at } = await confirmCellVerify(code);
        setPhase('verified');
        onVerified?.(cell_verified_at);
        return cell_verified_at;
      } catch (err) {
        setError(err instanceof ApiError ? confirmMessage(err.code) : "Couldn't verify the code — please try again.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [busy, onVerified],
  );

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setPendingCell(null);
  }, []);

  return { phase, busy, error, pendingCell, sendCode, confirm, reset };
}

/** Format a stored cell (E.164) + verified timestamp for the "Verified" line.
 *  Exported so the section renders it consistently. `me` may be a partial view. */
export function verifiedSummary(me: MeUser | undefined): { cell?: string; at?: string } {
  if (me === undefined) return {};
  return {
    ...(me.cell !== undefined && { cell: me.cell }),
    ...(me.cell_verified_at !== undefined && { at: me.cell_verified_at }),
  };
}
