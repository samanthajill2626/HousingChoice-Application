// Badge — a small pill for statuses, counts, and labels. Six tones map onto the
// token palette. `dot` prepends a status dot. The DeliveryBadge below is the
// specialized §7.1 delivery-state badge built on top of it.
import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'review';

export interface BadgeProps {
  tone?: BadgeTone;
  /** Prepend a status dot. */
  dot?: boolean;
  title?: string;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', dot = false, title, children }: BadgeProps): React.JSX.Element {
  return (
    <span className={`${styles.badge} ${styles[tone]}`} {...(title !== undefined && { title })}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}
