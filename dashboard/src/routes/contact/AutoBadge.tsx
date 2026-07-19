// AutoBadge - a tiny "Auto" pill rendered inline after a contact field value that
// carries AI-extraction provenance (its `<field>_source.source === 'ai'`). The
// accessible name is exactly "Auto"; the tooltip records when the fact was
// extracted. Purely informational (no action) - accepting/dismissing lives on the
// SuggestionChip.
import styles from './AutoBadge.module.css';

/** Format a provenance/suggestion instant as a friendly short date (the same
 *  style the AutoBadge tooltip uses), or '' when absent/unparseable. Shared with
 *  SuggestionChip so the badge tooltip and the chip's "(<date>)" read identically. */
export function formatSourceDate(at?: string): string {
  if (typeof at === 'string' && at.length > 0) {
    const d = new Date(at);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
  }
  return '';
}

export function AutoBadge({ at }: { at?: string }): React.JSX.Element {
  const when = formatSourceDate(at);
  const title = when.length > 0
    ? `Extracted from a conversation on ${when}`
    : 'Extracted from a conversation';
  return (
    <span role="img" aria-label="Auto" title={title} className={styles.badge}>
      Auto
    </span>
  );
}
