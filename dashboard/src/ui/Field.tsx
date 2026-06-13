// Field / Input / Textarea — labelled form controls. Field wraps a label, the
// control, and an optional hint/error, wiring aria-describedby + aria-invalid
// for accessibility. Input and Textarea are the bare controls (use inside a
// Field, or standalone). Each generates a stable id via React.useId when none
// is supplied.
import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import styles from './Field.module.css';

export interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}

/**
 * Field — labelled wrapper. Uses a render-prop so the control receives the
 * generated id + aria-describedby + invalid flag, keeping the wiring correct
 * without the caller repeating it.
 */
export function Field({ label, htmlFor, required, hint, error, children }: FieldProps): React.JSX.Element {
  const generated = useId();
  const id = htmlFor ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required && <span className={styles.required} aria-hidden="true">*</span>}
      </label>
      {children({ id, ...(describedBy !== undefined && { describedBy }), invalid: Boolean(error) })}
      {hint && (
        <span className={styles.hint} id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className={styles.error} id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input({ invalid, className, ...rest }: InputProps): React.JSX.Element {
  const cls = [styles.control, invalid ? styles.invalid : '', className ?? ''].filter(Boolean).join(' ');
  return <input className={cls} aria-invalid={invalid || undefined} {...rest} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, ...rest }: TextareaProps): React.JSX.Element {
  const cls = [styles.control, styles.textarea, invalid ? styles.invalid : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return <textarea className={cls} aria-invalid={invalid || undefined} {...rest} />;
}
