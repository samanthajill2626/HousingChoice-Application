// QuietHoursSection - the org's overnight quiet window (System tab). Automated
// tour reminders and placement nudges DEFER while the clock is inside this
// window (they are never dropped); anything a human sends is unaffected.
//
// Admin-only by ROUTE, not by component: the System tab is `adminOnly` in
// settingsTabs.ts and its element is wrapped in <AdminRoute> (App.tsx), which
// redirects a VA away before this ever mounts - so there is deliberately no
// in-component role gate here (worklist A2). PUT /api/settings is admin-only
// server-side regardless.
//
// The org timezone is DISPLAYED, not edited, this phase (the backend keeps a
// single org zone; a per-recipient zone rides the resolveQuietHoursTimezone
// seam server-side, not a control here).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type OrgSettings, type SettingsPatch } from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { useSettings } from './useSettings.js';
import styles from './QuietHoursSection.module.css';

/** A local, editable mirror of the three editable quiet-hours fields. */
interface FormState {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

function toForm(s: OrgSettings): FormState {
  return {
    quietHoursEnabled: s.quietHoursEnabled,
    quietHoursStart: s.quietHoursStart,
    quietHoursEnd: s.quietHoursEnd,
  };
}

/** The patch of CHANGED fields only, so a save never rewrites an untouched
 *  value (the server merges the patch over the stored record). */
function diff(form: FormState, base: OrgSettings): SettingsPatch {
  const patch: SettingsPatch = {};
  if (form.quietHoursEnabled !== base.quietHoursEnabled) {
    patch.quietHoursEnabled = form.quietHoursEnabled;
  }
  if (form.quietHoursStart !== base.quietHoursStart) {
    patch.quietHoursStart = form.quietHoursStart;
  }
  if (form.quietHoursEnd !== base.quietHoursEnd) {
    patch.quietHoursEnd = form.quietHoursEnd;
  }
  return patch;
}

/** Friendly copy for the one zone the org runs in today; any OTHER stored zone
 *  shows its raw IANA id rather than mislabeling which zone is in force. */
function timezoneLabel(timezone: string): string {
  return timezone === 'America/New_York' ? 'Eastern - America/New_York' : timezone;
}

/** A server 400 turned into copy a navigator can act on. The zero-length
 *  rejection comes back as a bare machine code, so it gets a sentence here; the
 *  field validators already return prose, which is passed through. */
function saveErrorMessage(err: ApiError): string {
  if (err.code === 'quiet_hours_zero_length') {
    return 'Start and end cannot be the same time - pick a real window, or turn quiet hours off.';
  }
  return err.message;
}

export function QuietHoursSection(): React.JSX.Element {
  const { status, settings, retry, save } = useSettings();

  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The latest form, read inside the hydrate effect WITHOUT making the form a
  // dependency (so the effect runs on `settings` changes only, never on edits).
  const formRef = useRef<FormState | null>(form);
  formRef.current = form;

  // Hydrate from the loaded settings, and re-hydrate after a save returns the
  // merged record - but never clobber an edit made while the PUT was in flight
  // (the TemplatesSection lost-edit guard).
  useEffect(() => {
    if (settings === undefined) return;
    const current = formRef.current;
    if (current === null || Object.keys(diff(current, settings)).length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(toForm(settings));
    }
  }, [settings]);

  const patch = useMemo(
    () => (form !== null && settings !== undefined ? diff(form, settings) : {}),
    [form, settings],
  );
  const dirty = Object.keys(patch).length > 0;

  async function onSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await save(patch);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(saveErrorMessage(err));
      } else {
        setError("Couldn't save - please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => (prev === null ? prev : { ...prev, [key]: value }));
    setSaved(false);
  }

  const timezoneText = settings !== undefined ? timezoneLabel(settings.timezone) : '';

  return (
    <section className={styles.section} aria-labelledby="quiet-hours-heading">
      <h2 id="quiet-hours-heading" className={styles.heading}>
        Quiet hours
      </h2>
      <p className={styles.lede}>
        Automated reminders and nudges WAIT until the window ends - they are never dropped.
        Messages a person sends are unaffected.
      </p>

      {status === 'loading' || form === null ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : status === 'error' ? (
        <div role="alert" className={styles.errorBlock}>
          <p>Couldn't load the quiet-hours settings.</p>
          <Button variant="secondary" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : (
        <form className={styles.form} onSubmit={(e) => void onSave(e)}>
          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={form.quietHoursEnabled}
              onChange={(e) => update('quietHoursEnabled', e.target.checked)}
            />
            <span>Pause automated messages overnight</span>
          </label>

          <div className={styles.times}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Start</span>
              <input
                className={styles.time}
                type="time"
                step={60}
                value={form.quietHoursStart}
                onChange={(e) => update('quietHoursStart', e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>End</span>
              <input
                className={styles.time}
                type="time"
                step={60}
                value={form.quietHoursEnd}
                onChange={(e) => update('quietHoursEnd', e.target.value)}
              />
            </label>
          </div>

          {/* Fixed copy, not a control - see the file header. */}
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Timezone</span>
            <p className={styles.fixedValue}>{timezoneText}</p>
          </div>

          {error !== null ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}

          <div className={styles.actions}>
            <Button type="submit" variant="primary" size="md" disabled={!dirty || saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            {saved && !dirty ? (
              <span role="status" className={styles.savedNote}>
                Saved
              </span>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
