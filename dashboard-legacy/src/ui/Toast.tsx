// Toast / notification — transient feedback. Wrap the app in <ToastProvider>
// (done in App.tsx) and call useToast() anywhere to push one:
//   const toast = useToast();
//   toast.success('Message sent'); toast.error('Send failed');
// The region is an aria-live polite landmark so screen readers announce toasts.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from './IconButton.js';
import { CloseIcon } from './icons.js';
import styles from './Toast.module.css';

export type ToastTone = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: ReactNode;
}

export interface ToastApi {
  show: (message: ReactNode, tone?: ToastTone) => void;
  success: (message: ReactNode) => void;
  error: (message: ReactNode) => void;
  info: (message: ReactNode) => void;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);

/** Auto-dismiss delay (ms). Errors linger a little longer than successes. */
const DISMISS_MS: Record<ToastTone, number> = { info: 4000, success: 3000, error: 6000 };

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: ReactNode, tone: ToastTone = 'info') => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, tone, message }]);
      setTimeout(() => dismiss(id), DISMISS_MS[tone]);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m) => show(m, 'success'),
      error: (m) => show(m, 'error'),
      info: (m) => show(m, 'info'),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`${styles.toast} ${styles[t.tone]}`}>
            <span className={styles.message}>{t.message}</span>
            <IconButton label="Dismiss" size="sm" className={styles.dismiss} onClick={() => dismiss(t.id)}>
              <CloseIcon size={16} />
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === undefined) {
    throw new Error('useToast must be used within a <ToastProvider>');
  }
  return ctx;
}
