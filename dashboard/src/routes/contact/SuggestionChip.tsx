// SuggestionChip - the inline review affordance for one pending AI suggestion on a
// contact field. Renders under the field it targets: the value the model heard
// (with when it was heard) plus Accept / Dismiss / View conversation. The server is
// authoritative - this renders only when a suggestion for the target is present in
// the fetched list (no client-side policy).
//
// Accessible names (e2e depends on these EXACTLY):
//   - container role=group, name `AI suggestion for <label>`
//   - text `AI heard "<value>"` (an OWN text node - a sibling span carries the date)
//   - buttons `Accept` and `Dismiss`; link `View conversation`
import { Link } from 'react-router-dom';
import type { SuggestionItem } from '../../api/index.js';
import { formatSourceDate } from './AutoBadge.js';
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
  // Same short date style as the AutoBadge tooltip (spec 5: `AI heard "<value>"
  // (<date>)`). Kept in a SIBLING span so `AI heard "<value>"` stays its own text
  // node - the e2e/component `getByText('AI heard "3"')` selectors stay exact.
  const when = formatSourceDate(suggestion.createdAt);
  return (
    <div role="group" aria-label={`AI suggestion for ${label}`} className={styles.chip}>
      <span className={styles.heard}>{`AI heard "${suggestion.suggestedValue}"`}</span>
      {when.length > 0 ? <span className={styles.date}>{`(${when})`}</span> : null}
      {suggestion.reason ? <span className={styles.reason}>{suggestion.reason}</span> : null}
      <span className={styles.actions}>
        <button type="button" className={styles.accept} onClick={onAccept} disabled={busy}>
          Accept
        </button>
        <button type="button" className={styles.dismiss} onClick={onDismiss} disabled={busy}>
          Dismiss
        </button>
        <Link className={styles.view} to={`/conversations/${suggestion.conversationId}`}>
          View conversation
        </Link>
      </span>
      {error ? (
        <span role="alert" className={styles.error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
