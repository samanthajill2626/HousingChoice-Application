// useSettings — owns the org-settings record for the Templates section: the
// initial GET, and a PUT that sends ONLY the changed fields (the server merges).
// VAs may VIEW (GET requireAuth) but not EDIT (PUT is admin-only); the section
// disables the inputs for VAs, so the save path here is only reached by admins.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSettings, putSettings, type OrgSettings, type SettingsPatch } from '../../api/index.js';

export type SettingsStatus = 'loading' | 'ready' | 'error';

export interface SettingsState {
  status: SettingsStatus;
  settings: OrgSettings | undefined;
  retry: () => void;
  /** PUT only the changed fields; returns the merged settings. Throws ApiError
   *  (e.g. 400) so the caller can surface validation inline. `welcomeText: null`
   *  clears a previously-set value. */
  save: (patch: SettingsPatch) => Promise<OrgSettings>;
}

export function useSettings(): SettingsState {
  const [status, setStatus] = useState<SettingsStatus>('loading');
  const [settings, setSettings] = useState<OrgSettings | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const s = await getSettings(controller.signal);
      if (controller.signal.aborted) return;
      setSettings(s);
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

  const retry = useCallback(() => {
    setStatus('loading');
    void load();
  }, [load]);

  const save = useCallback(async (patch: SettingsPatch): Promise<OrgSettings> => {
    const updated = await putSettings(patch);
    setSettings(updated);
    return updated;
  }, []);

  return { status, settings, retry, save };
}
