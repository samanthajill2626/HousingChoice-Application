// IconButton — a square, icon-only button. `label` is REQUIRED and becomes the
// aria-label (icon-only buttons must be labelled for assistive tech). Children
// are an inline SVG icon (from ./icons) — never an external icon font (CSP).
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './IconButton.module.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** Accessible name — required for an icon-only control. */
  label: string;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}

export function IconButton({
  label,
  size = 'md',
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps): React.JSX.Element {
  const cls = [styles.iconButton, size !== 'md' ? styles[size] : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={cls} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}
