// OWNED BY FEATURE AGENT 3 (M1.4) — founder-editable settings.
//
// Route: '/settings' (admin only — wrapped in <RequireAdmin> by the router).
// Two sections:
//   1. Missed-call templates (Change Order 2): the auto-text body + enabled
//      toggle, and the quick-reply templates list. GET /api/settings, PUT to
//      save (admin only; VAs get 403 'forbidden' — surfaced friendly). These are
//      consumed in M1.9 when calling goes live; we set that expectation honestly.
//   2. Notifications on this device: the push enable/disable + test surface
//      (this is how the founder turns push on, on her iPhone). Built on the
//      src/push helpers via usePushControl — handles every typed result reason.
import { useState } from 'react';
import {
  getSettings,
  updateSettings,
  useApi,
  type OrgSettings,
  type OrgSettingsPatch,
  type PushTestResult,
} from '../api/index.js';
import { Badge, Button, EmptyState, Field, Input, Spinner, Textarea, useToast } from '../ui/index.js';
import { settingsErrorMessage } from './admin/errors.js';
import { usePushControl, type PushState } from './admin/usePushControl.js';
import styles from './admin/Settings.module.css';

/** Server caps: auto-text + each quick reply ≤320 chars; ≤10 quick replies. */
const MAX_TEXT_LEN = 320;
const MAX_QUICK_REPLIES = 10;
/** Pre-ring pause bounds — mirror the backend (routes/settings.ts): whole 0..10. */
const MIN_PRE_RING_PAUSE = 0;
const MAX_PRE_RING_PAUSE = 10;

export default function Settings(): React.JSX.Element {
  const { data, loading, error, refetch } = useApi((signal) => getSettings(signal), []);

  return (
    <section className={styles.page}>
      <header className={styles.header}>
        <h1>Settings</h1>
        <p className={styles.lead}>Missed-call messages and notifications for this device.</p>
      </header>

      <MissedCallSection settings={data} loading={loading} hasError={error !== undefined} onRetry={refetch} />
      <NotificationsSection />
    </section>
  );
}

// --- 1. Missed-call templates ----------------------------------------------

function MissedCallSection({
  settings,
  loading,
  hasError,
  onRetry,
}: {
  settings: OrgSettings | undefined;
  loading: boolean;
  hasError: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  if (loading && settings === undefined) {
    return (
      <div className={styles.section}>
        <Spinner center label="Loading settings" />
      </div>
    );
  }
  if (settings === undefined) {
    return (
      <div className={styles.section}>
        <EmptyState
          title="Couldn't load settings"
          description={hasError ? 'Something went wrong.' : undefined}
          action={
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }
  return <MissedCallForm initial={settings} />;
}

function MissedCallForm({ initial }: { initial: OrgSettings }): React.JSX.Element {
  const toast = useToast();
  const [autoText, setAutoText] = useState(initial.missedCallAutoText);
  const [enabled, setEnabled] = useState(initial.missedCallAutoTextEnabled);
  const [quickReplies, setQuickReplies] = useState<string[]>(initial.quickReplies);
  const [newReply, setNewReply] = useState('');
  // Kept as a string so the input can be cleared/typed freely; validated below.
  const [preRingPause, setPreRingPause] = useState(String(initial.preRingPauseSeconds));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const autoTextOver = autoText.length > MAX_TEXT_LEN;
  const newReplyOver = newReply.length > MAX_TEXT_LEN;
  const anyReplyOver = quickReplies.some((r) => r.length > MAX_TEXT_LEN);
  const atReplyCap = quickReplies.length >= MAX_QUICK_REPLIES;
  // Pre-ring pause: a whole number in [0, 10]. A non-integer / out-of-range
  // value blocks save (mirrors the backend 400) and shows inline help.
  const preRingPauseNum = Number(preRingPause);
  const preRingPauseInvalid =
    preRingPause.trim() === '' ||
    !Number.isInteger(preRingPauseNum) ||
    preRingPauseNum < MIN_PRE_RING_PAUSE ||
    preRingPauseNum > MAX_PRE_RING_PAUSE;
  const invalid = autoTextOver || anyReplyOver || preRingPauseInvalid;

  function updateReply(index: number, value: string): void {
    setQuickReplies((current) => current.map((r, i) => (i === index ? value : r)));
  }

  function removeReply(index: number): void {
    setQuickReplies((current) => current.filter((_, i) => i !== index));
  }

  function addReply(): void {
    const trimmed = newReply.trim();
    if (trimmed === '' || atReplyCap || trimmed.length > MAX_TEXT_LEN) return;
    setQuickReplies((current) => [...current, trimmed]);
    setNewReply('');
  }

  async function handleSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (invalid) return;
    setSaveError(undefined);
    setSaving(true);
    const patch: OrgSettingsPatch = {
      missedCallAutoText: autoText,
      missedCallAutoTextEnabled: enabled,
      // Drop empties so a blank row never persists.
      quickReplies: quickReplies.map((r) => r.trim()).filter((r) => r !== ''),
      preRingPauseSeconds: preRingPauseNum,
    };
    try {
      const saved = await updateSettings(patch);
      setAutoText(saved.missedCallAutoText);
      setEnabled(saved.missedCallAutoTextEnabled);
      setQuickReplies(saved.quickReplies);
      setPreRingPause(String(saved.preRingPauseSeconds));
      toast.success('Settings saved.');
    } catch (err) {
      const message = settingsErrorMessage(err);
      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.section} onSubmit={(e) => void handleSave(e)} noValidate>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Missed-call messages</h2>
        <p className={styles.sectionHint}>
          Used when you miss a call — calling goes live in a later milestone.
        </p>
      </div>

      <div className={styles.toggleRow}>
        <label className={styles.toggleLabel} htmlFor="auto-text-enabled">
          Auto-text on every missed call
          <small>We text the caller automatically so no one is left hanging.</small>
        </label>
        <input
          id="auto-text-enabled"
          type="checkbox"
          className={styles.switch}
          role="switch"
          checked={enabled}
          disabled={saving}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </div>

      <Field
        label="Auto-text message"
        hint="Sent once per missed call (never per retry)."
        {...(autoTextOver && { error: `Keep it to ${MAX_TEXT_LEN} characters or fewer.` })}
      >
        {({ id, describedBy, invalid: fieldInvalid }) => (
          <>
            <Textarea
              id={id}
              rows={3}
              value={autoText}
              invalid={fieldInvalid}
              disabled={saving}
              {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
              onChange={(e) => setAutoText(e.target.value)}
            />
            <span className={`${styles.charCount} ${autoTextOver ? styles.charCountOver : ''}`}>
              {autoText.length}/{MAX_TEXT_LEN}
            </span>
          </>
        )}
      </Field>

      <Field
        label="Pre-ring pause (seconds)"
        hint="We send you a heads-up notification, then wait this long before ringing your cell — so the push lands just before the call. 0–10 seconds."
        {...(preRingPauseInvalid && {
          error: `Enter a whole number from ${MIN_PRE_RING_PAUSE} to ${MAX_PRE_RING_PAUSE}.`,
        })}
      >
        {({ id, describedBy, invalid: fieldInvalid }) => (
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={MIN_PRE_RING_PAUSE}
            max={MAX_PRE_RING_PAUSE}
            step={1}
            value={preRingPause}
            invalid={fieldInvalid}
            disabled={saving}
            {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
            onChange={(e) => setPreRingPause(e.target.value)}
          />
        )}
      </Field>

      <div className={styles.sectionHead}>
        <span className={styles.toggleLabel}>Quick replies</span>
        <p className={styles.sectionHint}>
          One-tap replies you can send after a missed call ({quickReplies.length}/
          {MAX_QUICK_REPLIES}).
        </p>
      </div>

      {quickReplies.length === 0 ? (
        <p className={styles.note}>No quick replies yet — add one below.</p>
      ) : (
        <ul className={styles.replyList}>
          {quickReplies.map((reply, index) => {
            const over = reply.length > MAX_TEXT_LEN;
            return (
              <li className={styles.replyItem} key={index}>
                <Input
                  className={styles.control}
                  aria-label={`Quick reply ${index + 1}`}
                  value={reply}
                  invalid={over}
                  disabled={saving}
                  onChange={(e) => updateReply(index, e.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  aria-label={`Remove quick reply ${index + 1}`}
                  onClick={() => removeReply(index)}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.replyAdd}>
        <Input
          className={styles.control}
          aria-label="New quick reply"
          placeholder="Add a quick reply"
          value={newReply}
          invalid={newReplyOver}
          disabled={saving || atReplyCap}
          onChange={(e) => setNewReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addReply();
            }
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={saving || atReplyCap || newReply.trim() === '' || newReplyOver}
          onClick={addReply}
        >
          Add
        </Button>
      </div>
      {atReplyCap && (
        <p className={styles.note}>You&apos;ve reached the limit of {MAX_QUICK_REPLIES} quick replies.</p>
      )}

      <div className={styles.saveRow}>
        <Button type="submit" loading={saving} disabled={invalid}>
          Save changes
        </Button>
        {saveError !== undefined && (
          <span className={styles.saveError} role="alert">
            {saveError}
          </span>
        )}
      </div>
    </form>
  );
}

// --- 2. Notifications on this device ---------------------------------------

const PUSH_COPY: Record<PushState, { tone: Parameters<typeof Badge>[0]['tone']; label: string; detail: string }> = {
  checking: { tone: 'neutral', label: 'Checking…', detail: 'Checking notification status.' },
  subscribed: {
    tone: 'success',
    label: 'On',
    detail: "You'll get a push on this device for missed calls and new messages.",
  },
  not_subscribed: {
    tone: 'neutral',
    label: 'Off',
    detail: 'Turn on notifications to get a push on this device.',
  },
  denied: {
    tone: 'warning',
    label: 'Blocked',
    detail:
      'Notifications are blocked for this site. Allow them in your browser settings, then enable again.',
  },
  unsupported: {
    tone: 'neutral',
    label: 'Not available',
    detail: "This browser can't show push notifications.",
  },
  not_configured: {
    tone: 'warning',
    label: 'Unavailable',
    detail: 'Push isn’t set up on the server yet — ask your admin to configure it.',
  },
  error: {
    tone: 'danger',
    label: 'Error',
    detail: 'Something went wrong with notifications. Try again.',
  },
};

function NotificationsSection(): React.JSX.Element {
  const toast = useToast();
  const [lastTest, setLastTest] = useState<PushTestResult | undefined>(undefined);

  const push = usePushControl(
    (result) => {
      setLastTest(result);
      if (!result.configured) {
        toast.info('Push isn’t configured on the server yet.');
      } else if (result.attempted === 0) {
        toast.info('No devices are subscribed yet — enable notifications first.');
      } else {
        toast.success(`Test sent to ${result.sent} of ${result.attempted} device(s).`);
      }
    },
    (message) => toast.error(message),
  );

  const copy = PUSH_COPY[push.state];

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Notifications on this device</h2>
        <p className={styles.sectionHint}>
          Get a push when you miss a call or a new message comes in.
        </p>
      </div>

      <div className={styles.pushState}>
        <Badge tone={copy.tone} dot>
          {copy.label}
        </Badge>
        <span>{copy.detail}</span>
      </div>

      {/* iPhone PWA caveat — push only works once added to the Home Screen. */}
      <p className={styles.iosNote}>
        On iPhone, add this app to your Home Screen first, then enable notifications.
      </p>

      <div className={styles.pushActions}>
        {push.state === 'subscribed' ? (
          <Button variant="secondary" loading={push.busy} onClick={push.disable}>
            Turn off notifications
          </Button>
        ) : (
          <Button
            loading={push.busy}
            disabled={
              push.state === 'unsupported' ||
              push.state === 'not_configured' ||
              push.state === 'checking'
            }
            onClick={push.enable}
          >
            Enable notifications
          </Button>
        )}
        <Button
          variant="ghost"
          loading={push.testing}
          disabled={push.state !== 'subscribed'}
          onClick={push.test}
        >
          Send test notification
        </Button>
      </div>

      {lastTest !== undefined && (
        <p className={styles.note}>
          Last test: attempted {lastTest.attempted}, sent {lastTest.sent}
          {lastTest.failed > 0 ? `, failed ${lastTest.failed}` : ''}.
        </p>
      )}
    </div>
  );
}
