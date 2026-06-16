// Spinner — an indeterminate loading indicator. Use `center` to render it
// padded + centered as a page/section loading state. Inherits text color
// (currentColor) so it sits naturally inside buttons and on any surface.
import styles from './Spinner.module.css';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  /** Center the spinner in a padded block (section/page loading state). */
  center?: boolean;
  /** Accessible label (default "Loading"). */
  label?: string;
}

export function Spinner({ size = 'md', center = false, label = 'Loading' }: SpinnerProps): React.JSX.Element {
  const spinner = (
    <span className={`${styles.spinner} ${styles[size]}`} role="status" aria-label={label} />
  );
  if (center) return <div className={styles.center}>{spinner}</div>;
  return spinner;
}
