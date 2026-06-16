// Button — the action primitive for the fake-phones dev UI. Ported from the
// dashboard's Button idiom (typed props, a `classes()` helper, --hc-* tokens, a
// :focus-visible ring) and kept deliberately small: no loading/Spinner state is
// needed here. Renders a <button>.
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full-width block button. */
  block?: boolean;
  children?: ReactNode;
}

function classes(variant: ButtonVariant, size: ButtonSize, block: boolean, className?: string): string {
  return [styles.button, styles[variant], styles[size], block ? styles.block : '', className ?? '']
    .filter(Boolean)
    .join(' ');
}

export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button type={type} className={classes(variant, size, block, className)} {...rest}>
      {children}
    </button>
  );
}
