// Avatar / InitialsBadge — a circular initials chip. There are no uploaded
// photos in the product, so this is initials-only. `review` tone marks an
// un-triaged ("needs review" / unknown) identity — surfacing the honest-identity
// state rather than faking a name. Pass a name to derive initials, or initials
// directly; an unknown contact passes no name and gets a "?" in the review tone.
import { initialsFrom } from './initials.js';
import styles from './Avatar.module.css';

export interface AvatarProps {
  /** Full name (e.g. "Keisha Jones") — initials are derived from it. */
  name?: string;
  /** Explicit initials override (1–2 chars). */
  initials?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Use the "needs review" / unknown tone (honest-identity state). */
  review?: boolean;
}

export function Avatar({ name, initials, size = 'md', review = false }: AvatarProps): React.JSX.Element {
  const text = initials ?? initialsFrom(name);
  const cls = [styles.avatar, styles[size], review ? styles.review : ''].filter(Boolean).join(' ');
  return (
    <span className={cls} aria-hidden="true">
      {text}
    </span>
  );
}
