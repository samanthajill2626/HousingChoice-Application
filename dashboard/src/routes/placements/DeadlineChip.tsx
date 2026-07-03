// DeadlineChip — a compact, colour-coded urgency chip for a placement's next
// deadline: "overdue" (red) / "due in Nd" (amber). Renders nothing when the
// placement carries no deadline. The clock type + full date live in the title
// tooltip (the placement detail shows them inline). Buckets mirror the Today
// queue's urgency badge so the board, the files, the detail, and Today agree.
import type { PlacementItem } from '../../api/index.js';
import { DEADLINE_TYPE_LABEL, deadlineRelative } from './placementsFormat.js';
import styles from './DeadlineChip.module.css';

export function DeadlineChip({
  placement,
}: {
  placement: Pick<PlacementItem, 'next_deadline_at' | 'next_deadline_type'>;
}): React.JSX.Element | null {
  const at = placement.next_deadline_at;
  if (typeof at !== 'string') return null;
  const rel = deadlineRelative(at);
  if (!rel.text) return null;
  const label = placement.next_deadline_type
    ? DEADLINE_TYPE_LABEL[placement.next_deadline_type] ?? ''
    : '';
  const when = new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <span
      className={`${styles.chip} ${rel.overdue ? styles.overdue : styles.soon}`}
      title={label ? `${label} — ${when}` : when}
    >
      {rel.text}
    </span>
  );
}
