// useSettings — owns the org-settings record for the Templates section: the
// initial GET, and a PUT that sends ONLY the changed fields (the server merges).
// VAs may VIEW (GET requireAuth) but not EDIT (PUT is admin-only); the section
// disables the inputs for VAs, so the save path here is only reached by admins.
// Also the source of the read-only, env-sourced `businessPhoneNumber` the Phone
// numbers section shows to EVERY authenticated user (both responses carry it).
import { useCallback, useEffect, useRef, useState } from 'react';
import { getSettings, putSettings, type OrgSettings, type SettingsPatch } from '../../api/index.js';

export type SettingsStatus = 'loading' | 'ready' | 'error';

export interface SettingsState {
  status: SettingsStatus;
  settings: OrgSettings | undefined;
  /** The read-only built-in welcome body (what a blank welcomeText sends) —
   *  served alongside the settings so the UI can SHOW the default. */
  welcomeTextDefault: string | undefined;
  /** OUR one business number (env-sourced, read-only, never patchable), E.164 -
   *  `undefined` when the deployment has none configured (the backend OMITS the
   *  key rather than sending null). Served by BOTH the GET and the PUT, which
   *  is why `save()` below re-stores it too. */
  businessPhoneNumber: string | undefined;
  retry: () => void;
  /** PUT only the changed fields; returns the merged settings. Throws ApiError
   *  (e.g. 400) so the caller can surface validation inline. `welcomeText: null`
   *  clears a previously-set value. */
  save: (patch: SettingsPatch) => Promise<OrgSettings>;
}

export function useSettings(): SettingsState {
  const [status, setStatus] = useState<SettingsStatus>('loading');
  const [settings, setSettings] = useState<OrgSettings | undefined>(undefined);
  const [welcomeTextDefault, setWelcomeTextDefault] = useState<string | undefined>(undefined);
  const [businessPhoneNumber, setBusinessPhoneNumber] = useState<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await getSettings(controller.signal);
      if (controller.signal.aborted) return;
      setSettings(res.settings);
      setWelcomeTextDefault(res.welcomeTextDefault);
      setBusinessPhoneNumber(res.businessPhoneNumber);
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
    const res = await putSettings(patch);
    setSettings(res.settings);
    setWelcomeTextDefault(res.welcomeTextDefault);
    // The PUT carries the read-only siblings too: re-store them, or a save
    // BLANKS whatever is showing them (the Phone numbers "Our number" block).
    setBusinessPhoneNumber(res.businessPhoneNumber);
    return res.settings;
  }, []);

  return { status, settings, welcomeTextDefault, businessPhoneNumber, retry, save };
}
