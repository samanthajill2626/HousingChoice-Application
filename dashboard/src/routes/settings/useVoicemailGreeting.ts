// Owns the voicemail greeting for the Voice tab (voicemail-greeting spec 4.7):
// one GET of the org settings (keeping only `voicemailGreeting`), the raw-body
// upload with the client-side pre-checks that mirror the server's rules, and
// the remove. A small dedicated hook rather than useSettings: that hook's
// `save` is the Templates JSON PUT and the greeting's writes are not a JSON
// patch.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  getSettings,
  removeVoicemailGreeting,
  uploadVoicemailGreeting,
  type VoicemailGreeting,
} from '../../api/index.js';

export const GREETING_MAX_BYTES = 5 * 1024 * 1024;
/** Verbatim the server's message (decision 1). */
export const GREETING_REJECT_MESSAGE =
  'Upload an MP3 or WAV file. iPhone voice memos are M4A; export or convert the recording first.';
export const GREETING_TOO_LARGE_MESSAGE = 'That file is over 5 MB. Trim or re-export it at a lower bitrate.';
export const GREETING_EMPTY_MESSAGE = 'That file is empty.';
export const GREETING_STORAGE_MESSAGE = "Media storage isn't available right now. Try again in a minute.";
export const GREETING_FORBIDDEN_MESSAGE = 'Only an admin can change the greeting.';
/** The server stored the file but could not write its record (spec 4.3). What
 *  callers hear depends on the case - a REPLACE plays the new file under the
 *  old record; a FIRST upload leaves no record, so callers keep the built-in
 *  prompt - so the message claims neither. The block re-fetches so it shows
 *  what the server holds, and the next successful upload repairs both. */
export const GREETING_RECORD_FAILED_MESSAGE =
  "The file was uploaded, but its details couldn't be saved. Upload it again.";
export const GREETING_UPLOAD_FAILED_MESSAGE = "Couldn't upload the greeting. Try again.";
export const GREETING_REMOVE_FAILED_MESSAGE = "Couldn't remove the greeting. Try again.";

/**
 * The canonical audio type to declare for `file`, or undefined when it is not
 * an MP3/WAV. Browsers report `audio/mpeg` / `audio/wav` (Chrome) or aliases
 * (`audio/mp3`, `audio/x-wav`, `audio/wave`, `audio/vnd.wave`); an EMPTY type
 * with a .mp3/.wav name is mapped from the extension so the server, which
 * decides by the header bytes, gets to see it.
 */
export function greetingContentTypeFor(file: File): string | undefined {
  const type = file.type.trim().toLowerCase();
  if (type === 'audio/mpeg' || type === 'audio/mp3') return 'audio/mpeg';
  if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave' || type === 'audio/vnd.wave') return 'audio/wav';
  if (type === '') {
    const name = file.name.toLowerCase();
    if (name.endsWith('.mp3')) return 'audio/mpeg';
    if (name.endsWith('.wav')) return 'audio/wav';
  }
  return undefined;
}

export type GreetingStatus = 'loading' | 'ready' | 'error';

export interface VoicemailGreetingState {
  status: GreetingStatus;
  greeting: VoicemailGreeting | undefined;
  busy: boolean;
  /** A USER-ACTION failure (rendered as an alert). */
  error: string | null;
  /** A success line (rendered as a status). */
  notice: string | null;
  upload: (file: File) => Promise<void>;
  remove: () => Promise<void>;
  retry: () => void;
  /** Drop a stale user-action error (the block calls it before opening the
   *  Remove dialog so an earlier upload rejection is not shown inside it). */
  clearError: () => void;
}

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'unsupported_media_type':
        return GREETING_REJECT_MESSAGE;
      case 'file_too_large':
        return GREETING_TOO_LARGE_MESSAGE;
      case 'empty_file':
        return GREETING_EMPTY_MESSAGE;
      case 'media_storage_unavailable':
        return GREETING_STORAGE_MESSAGE;
      case 'greeting_record_failed':
        return GREETING_RECORD_FAILED_MESSAGE;
      case 'forbidden':
        return GREETING_FORBIDDEN_MESSAGE;
      default:
        return fallback;
    }
  }
  return fallback;
}

export function useVoicemailGreeting(): VoicemailGreetingState {
  const [status, setStatus] = useState<GreetingStatus>('loading');
  const [greeting, setGreeting] = useState<VoicemailGreeting | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await getSettings(controller.signal);
      if (controller.signal.aborted) return;
      setGreeting(res.settings.voicemailGreeting);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const retry = useCallback(() => {
    setStatus('loading');
    void load();
  }, [load]);

  const upload = useCallback(async (file: File) => {
    setError(null);
    setNotice(null);
    const contentType = greetingContentTypeFor(file);
    if (contentType === undefined) {
      setError(GREETING_REJECT_MESSAGE);
      return;
    }
    if (file.size === 0) {
      setError(GREETING_EMPTY_MESSAGE);
      return;
    }
    if (file.size > GREETING_MAX_BYTES) {
      setError(GREETING_TOO_LARGE_MESSAGE);
      return;
    }
    const replacing = greeting !== undefined;
    // A re-fetch still in flight (from an earlier greeting_record_failed) must
    // not land AFTER this action and overwrite its result with stale state.
    abortRef.current?.abort();
    setBusy(true);
    try {
      const next = await uploadVoicemailGreeting(file, contentType);
      setGreeting(next);
      setNotice(replacing ? 'Greeting replaced.' : 'Greeting uploaded.');
    } catch (err) {
      setError(messageFor(err, GREETING_UPLOAD_FAILED_MESSAGE));
      // The object was stored but its record was not: show what the server
      // actually holds (the previous record, or none) rather than the stale
      // local state - the caller can then upload again to repair the details.
      if (err instanceof ApiError && err.code === 'greeting_record_failed') void load();
    } finally {
      setBusy(false);
    }
  }, [greeting, load]);

  const remove = useCallback(async () => {
    setError(null);
    setNotice(null);
    // Same fence as upload: an in-flight re-fetch must not overwrite the remove.
    abortRef.current?.abort();
    setBusy(true);
    try {
      await removeVoicemailGreeting();
      setGreeting(undefined);
      setNotice('Greeting removed.');
    } catch (err) {
      setError(messageFor(err, GREETING_REMOVE_FAILED_MESSAGE));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { status, greeting, busy, error, notice, upload, remove, retry, clearError };
}
