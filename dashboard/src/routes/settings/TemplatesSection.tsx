// TemplatesSection — the founder-editable call-triage templates (+ the
// housing-fair welcome text). All users may VIEW; only admins EDIT (the PUT is
// admin-only), so for a VA every input is disabled and the Save button is gone
// (a "read-only" note explains why). Save sends ONLY the changed fields and
// surfaces a 400 validation error inline; the server is authoritative.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type OrgSettings, type SettingsPatch } from '../../api/index.js';
import { useAuth } from '../../app/AuthContext.js';
import { Button, Spinner } from '../../ui/index.js';
import { useSettings } from './useSettings.js';
import { QuickRepliesEditor } from './QuickRepliesEditor.js';
import styles from './TemplatesSection.module.css';

const MAX_TEMPLATE_CHARS = 320;
const MIN_PRE_RING = 0;
const MAX_PRE_RING = 10;
const MAX_QUICK_REPLIES = 10;

/** A local, editable mirror of the five settings fields. welcomeText is a string
 *  here (empty box = "use the default"): when the box is cleared from a
 *  previously-set value the patch carries `welcomeText: null` (an explicit CLEAR);
 *  when it was never set and stays empty nothing is sent; a non-empty value is
 *  sent verbatim. */
interface FormState {
  preRingPauseSeconds: number;
  missedCallAutoText: string;
  missedCallAutoTextEnabled: boolean;
  quickReplies: string[];
  welcomeText: string;
}

function toForm(s: OrgSettings): FormState {
  return {
    preRingPauseSeconds: s.preRingPauseSeconds,
    missedCallAutoText: s.missedCallAutoText,
    missedCallAutoTextEnabled: s.missedCallAutoTextEnabled,
    quickReplies: [...s.quickReplies],
    welcomeText: s.welcomeText ?? '',
  };
}

/** The patch of CHANGED fields only (so an admin's save never touches untouched
 *  values). welcomeText: a non-empty change is sent verbatim; CLEARING a
 *  previously-set value sends `welcomeText: null` (an explicit revert-to-default,
 *  which the backend turns into a REMOVE); a box that was empty and stays empty
 *  sends nothing (the backend rejects empty strings). */
function diff(form: FormState, base: OrgSettings): SettingsPatch {
  const patch: SettingsPatch = {};
  if (form.preRingPauseSeconds !== base.preRingPauseSeconds) {
    patch.preRingPauseSeconds = form.preRingPauseSeconds;
  }
  if (form.missedCallAutoText !== base.missedCallAutoText) {
    patch.missedCallAutoText = form.missedCallAutoText;
  }
  if (form.missedCallAutoTextEnabled !== base.missedCallAutoTextEnabled) {
    patch.missedCallAutoTextEnabled = form.missedCallAutoTextEnabled;
  }
  if (
    form.quickReplies.length !== base.quickReplies.length ||
    form.quickReplies.some((r, i) => r !== base.quickReplies[i])
  ) {
    patch.quickReplies = form.quickReplies;
  }
  const baseWelcome = base.welcomeText ?? '';
  if (form.welcomeText !== baseWelcome) {
    if (form.welcomeText.length > 0) {
      patch.welcomeText = form.welcomeText;
    } else if (baseWelcome.length > 0) {
      // Cleared a previously-set value → explicit CLEAR (revert to default).
      patch.welcomeText = null;
    }
    // (never-set + still-empty → no key; the backend rejects empty strings)
  }
  return patch;
}

export function TemplatesSection(): React.JSX.Element {
  const { isAdmin } = useAuth();
  const { status, settings, retry, save } = useSettings();

  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The latest form, read inside the hydrate effect WITHOUT making the form a
  // dependency (so the effect runs on `settings` changes only, never on keystrokes).
  const formRef = useRef<FormState | null>(form);
  formRef.current = form;

  // Hydrate the local form from the loaded settings (and re-hydrate after a save
  // returns the merged record). GUARD: do NOT clobber edits the user made while a
  // PUT was in flight — only (re)hydrate when there is no form yet (initial load)
  // or the current form has NO pending edits relative to the incoming baseline.
  // Without this, the post-save `settings` update would overwrite a field the
  // user changed after clicking Save but before the PUT resolved (a lost edit).
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
    if (!isAdmin || !dirty || saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await save(patch);
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError(err.message);
      } else {
        setError("Couldn't save — please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => (prev === null ? prev : { ...prev, [key]: value }));
    setSaved(false);
  }

  const disabled = !isAdmin;

  return (
    <section className={styles.section} aria-labelledby="templates-heading">
      <h2 id="templates-heading" className={styles.heading}>
        Templates
      </h2>

      {disabled ? (
        <p className={styles.readonlyNote}>Read-only — admins can edit these templates.</p>
      ) : null}

      {status === 'loading' || form === null ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : status === 'error' ? (
        <div role="alert" className={styles.errorBlock}>
          <p>Couldn't load the templates.</p>
          <Button variant="secondary" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : (
        <form className={styles.form} onSubmit={(e) => void onSave(e)}>
          {/* Pre-ring pause (0–10s) */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Pre-ring pause (seconds)</span>
            <input
              className={styles.number}
              type="number"
              min={MIN_PRE_RING}
              max={MAX_PRE_RING}
              step={1}
              value={form.preRingPauseSeconds}
              disabled={disabled}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n)) {
                  update('preRingPauseSeconds', Math.max(MIN_PRE_RING, Math.min(MAX_PRE_RING, n)));
                }
              }}
            />
            <span className={styles.hint}>
              How far ahead the founder push lands before the bridge dials (0–10).
            </span>
          </label>

          {/* Missed-call auto-text + on/off */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Missed-call auto-text</span>
            <textarea
              className={styles.textarea}
              rows={3}
              maxLength={MAX_TEMPLATE_CHARS}
              value={form.missedCallAutoText}
              disabled={disabled}
              onChange={(e) => update('missedCallAutoText', e.target.value)}
            />
            <span className={styles.hint}>
              {form.missedCallAutoText.length}/{MAX_TEMPLATE_CHARS}
            </span>
          </label>

          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={form.missedCallAutoTextEnabled}
              disabled={disabled}
              onChange={(e) => update('missedCallAutoTextEnabled', e.target.checked)}
            />
            <span>Send the missed-call auto-text automatically</span>
          </label>

          {/* Quick replies (chip list) */}
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Quick replies</span>
            <QuickRepliesEditor
              replies={form.quickReplies}
              disabled={disabled}
              max={MAX_QUICK_REPLIES}
              maxChars={MAX_TEMPLATE_CHARS}
              onChange={(next) => update('quickReplies', next)}
            />
          </div>

          {/* Welcome text (housing-fair) */}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Housing-fair welcome text</span>
            <textarea
              className={styles.textarea}
              rows={3}
              maxLength={MAX_TEMPLATE_CHARS}
              value={form.welcomeText}
              disabled={disabled}
              placeholder="Leave blank to use the default welcome message."
              onChange={(e) => update('welcomeText', e.target.value)}
            />
            <span className={styles.hint}>
              Use <code>{'{firstName}'}</code> where the person's first name should go.
              Blank uses the built-in default.
            </span>
          </label>

          {error !== null ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}

          {!disabled ? (
            <div className={styles.actions}>
              <Button type="submit" variant="primary" size="md" disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {saved && !dirty ? (
                <span role="status" className={styles.savedNote}>
                  Saved
                </span>
              ) : null}
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}
