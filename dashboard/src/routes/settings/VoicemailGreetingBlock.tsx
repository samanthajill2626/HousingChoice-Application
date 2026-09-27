// Settings > Voice > "Voicemail greeting" (voicemail-greeting spec 4.7). Every
// logged-in user sees the current greeting and can play it; only an admin can
// upload, replace or remove it. Load failures are a STATUS line (never an
// alert - the cell-verification flow above owns the section's alert semantics
// and the perf terminal forbids an alert at load); user-action failures are
// alerts. Mounted OUTSIDE VoiceSection's useMe ternary so a /users/me failure
// never hides the greeting.
import { useRef, useState } from 'react';
import { useOptionalAuth } from '../../app/AuthContext.js';
import { voicemailGreetingAudioUrl } from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { useVoicemailGreeting } from './useVoicemailGreeting.js';
import styles from './VoiceSection.module.css';

const ACCEPT = 'audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav';

function fmtUploadedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function VoicemailGreetingBlock(): React.JSX.Element {
  const auth = useOptionalAuth();
  const isAdmin = auth?.isAdmin === true;
  const state = useVoicemailGreeting();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The player src that last fired `error`. The missing-file line shows while
  // THAT src is still the mounted one, so it clears only when the src changes
  // (a successful upload or replace carries a new ?v=), never merely because a
  // file was chosen: a refused Replace leaves the same broken player, whose
  // <audio> never re-fires error. Spec 4.3 Concurrency wants that state
  // visible until a re-upload repairs it (fix wave R1, FW3).
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be chosen again
    if (!file) return;
    await state.upload(file);
  }

  async function onConfirmRemove(): Promise<void> {
    try {
      await state.remove();
      setConfirming(false);
    } catch {
      // the hook surfaced the message; keep the dialog open
    }
  }

  const g = state.greeting;
  const audioSrc = g === undefined ? undefined : voicemailGreetingAudioUrl(g);
  const playerBroken = audioSrc !== undefined && brokenSrc === audioSrc;

  return (
    // A plain div on purpose: an aria-labelledby here would give the wrapper the
    // SAME accessible name as the <audio aria-label="Voicemail greeting"> below,
    // and both RTL's getByLabelText and Playwright's getByLabel would then match
    // two elements.
    <div className={styles.greetingBlock}>
      <h3 className={styles.greetingHeading}>Voicemail greeting</h3>
      <p className={styles.greetingHelp}>
        When a call to the business line isn&apos;t answered, callers hear this greeting before the
        beep. Upload an MP3 or WAV file up to 5 MB. iPhone voice memos are M4A; export or convert the
        recording first. Without a greeting, callers hear the built-in spoken prompt.
        {isAdmin ? null : ' An admin can upload or change it.'}
      </p>

      {state.status === 'loading' ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : state.status === 'error' ? (
        <div className={styles.greetingRow}>
          <span role="status" className={styles.greetingStatus}>
            Couldn&apos;t load the voicemail greeting.
          </span>
          <Button variant="secondary" size="sm" onClick={state.retry}>
            Retry
          </Button>
        </div>
      ) : g === undefined ? (
        <div className={styles.greetingRow}>
          <span role="status" className={styles.greetingStatus}>
            No greeting uploaded - callers hear the built-in prompt.
          </span>
          {isAdmin ? (
            <Button variant="primary" size="sm" onClick={() => inputRef.current?.click()} disabled={state.busy}>
              {state.busy ? 'Uploading...' : 'Upload greeting'}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className={styles.greetingCurrent}>
          <div className={styles.greetingMeta}>
            <span className={styles.greetingName}>{g.fileName}</span>
            <span className={styles.greetingDate}>
              Uploaded {fmtUploadedAt(g.uploadedAt)} by {g.uploadedByEmail}
            </span>
          </div>
          {/* preload="metadata": the browser fetches the header at load, so a
              missing object surfaces (onError) without anyone pressing play. */}
          <audio
            className={styles.greetingPlayer}
            controls
            preload="metadata"
            src={audioSrc}
            aria-label="Voicemail greeting"
            onError={() => setBrokenSrc(audioSrc ?? null)}
          />
          {playerBroken ? (
            <span role="status" className={styles.greetingStatus}>
              The greeting file is missing or can&apos;t be played. Upload it again.
            </span>
          ) : null}
          {isAdmin ? (
            <div className={styles.greetingActions}>
              <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()} disabled={state.busy}>
                {state.busy ? 'Uploading...' : 'Replace greeting'}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  state.clearError(); // a stale upload rejection must not appear inside the dialog
                  setConfirming(true);
                }}
                disabled={state.busy}
              >
                Remove greeting
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {state.notice !== null ? (
        <p role="status" className={styles.greetingNotice}>
          {state.notice}
        </p>
      ) : null}
      {state.error !== null && !confirming ? (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      ) : null}

      {/* Rendered only once LOADED, and disabled while busy: like the repo's
          other sr-only file inputs it stays in the tab order, so an input
          present during the initial GET would let a keyboard user start an
          upload that the GET's stale response then overwrites, and an enabled
          one would allow a second upload while the first is in flight. The
          visible Upload/Replace buttons exist only in this state too. */}
      {isAdmin && state.status === 'ready' ? (
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          aria-label="Greeting audio file"
          className={styles.greetingInput}
          disabled={state.busy}
          onChange={(e) => void onFileChosen(e)}
        />
      ) : null}

      {confirming ? (
        <Modal
          title="Remove voicemail greeting?"
          onClose={state.busy ? () => {} : () => setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={state.busy}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={() => void onConfirmRemove()} disabled={state.busy}>
                {state.busy ? 'Removing...' : 'Remove'}
              </Button>
            </>
          }
        >
          <p className={styles.greetingDialogText}>
            Callers will hear the built-in spoken prompt instead. You can upload a new greeting any
            time.
          </p>
          {/* A failed Remove reports INSIDE the dialog (the ConfirmRemoveDialog
              shape): the block-level alert above sits behind the fixed modal
              backdrop and outside the aria-modal scope, where nobody sees it. */}
          {state.error !== null ? (
            <p role="alert" className={styles.error}>
              {state.error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
