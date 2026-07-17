// SuggestionChip - the inline review affordance for one pending AI suggestion on a
// contact field. Renders under the field it targets: the value the model heard
// plus Accept / Dismiss. The server is authoritative - this renders only when a
// suggestion for the target is present in the fetched list (no client-side policy).
//
// Accessible names (e2e depends on these EXACTLY):
//   - container role=group, name `AI suggestion for <label>`
//   - text `AI heard "<value>"`
//   - buttons `Accept` and `Dismiss`
import type { SuggestionItem } from '../../api/index.js';
import styles from './SuggestionChip.module.css';

export interface SuggestionChipProps {
  /** Human label of the field the suggestion targets (e.g. "voucher size",
   *  "status"). Forms the group's accessible name `AI suggestion for <label>`. */
  label: string;
  suggestion: SuggestionItem;
  onAccept: () => void;
  onDismiss: () => void;
  /** In-flight: disables both actions. */
  busy?: boolean;
  /** Inline error (e.g. a phone already-in-use conflict). */
  error?: string | null;
}

export function SuggestionChip({
  label,
  suggestion,
  onAccept,
  onDismiss,
  busy = false,
  error,
}: SuggestionChipProps): React.JSX.Element {
  return (
    <div role="group" aria-label={`AI suggestion for ${label}`} className={styles.chip}>
      <span className={styles.heard}>{`AI heard "${suggestion.suggestedValue}"`}</span>
      {suggestion.reason ? <span className={styles.reason}>{suggestion.reason}</span> : null}
      <span className={styles.actions}>
        <button type="button" className={styles.accept} onClick={onAccept} disabled={busy}>
          Accept
        </button>
        <button type="button" className={styles.dismiss} onClick={onDismiss} disabled={busy}>
          Dismiss
        </button>
      </span>
      {error ? (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
