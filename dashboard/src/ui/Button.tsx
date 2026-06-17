// Button — the primary action primitive. Renders a <button> by default; when
// `as="a"` it renders an <a> (for navigations like the login link). Supports
// variants, sizes, full-width, and a loading state that shows a Spinner and
// disables interaction.
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner.js';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Full-width block button. */
  block?: boolean;
  /** Shows a spinner and blocks interaction. */
  loading?: boolean;
  children?: ReactNode;
}

type ButtonAsButton = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof CommonProps> & {
    as?: 'button';
  };

type ButtonAsAnchor = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof CommonProps> & {
    as: 'a';
  };

export type ButtonProps = ButtonAsButton | ButtonAsAnchor;

function classes(
  variant: ButtonVariant,
  size: ButtonSize,
  block: boolean,
  className?: string,
): string {
  return [styles.button, styles[variant], styles[size], block ? styles.block : '', className ?? '']
    .filter(Boolean)
    .join(' ');
}

export function Button(props: ButtonProps): React.JSX.Element {
  const {
    variant = 'primary',
    size = 'md',
    block = false,
    loading = false,
    children,
    className,
    ...rest
  } = props;
  const cls = classes(variant, size, block, className);

  if (props.as === 'a') {
    const anchorRest = rest as AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a className={cls} {...anchorRest}>
        {loading && <Spinner size="sm" />}
        {children}
      </a>
    );
  }

  const buttonRest = rest as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button
      className={cls}
      disabled={loading || buttonRest.disabled}
      aria-busy={loading || undefined}
      {...buttonRest}
    >
      {loading && <Spinner size="sm" />}
      {children}
    </button>
  );
}
