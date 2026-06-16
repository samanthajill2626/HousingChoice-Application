// EmptyState — the centered "nothing here yet" / "no results" block. Optional
// leading icon (inline SVG), a title, a description, and an action slot
// (typically a Button). Also doubles as a lightweight error state.
import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** Action slot — e.g. a retry or primary Button. */
  action?: ReactNode;
  /** ARIA role for the outer container. Defaults to 'status' so a
   *  loading→empty/error swap is announced by screen readers. */
  role?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  role = 'status',
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className={styles.empty} role={role}>
      {icon && <div className={styles.icon}>{icon}</div>}
      <div className={styles.title}>{title}</div>
      {description && <div className={styles.description}>{description}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
