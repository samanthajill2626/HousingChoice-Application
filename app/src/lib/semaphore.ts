// A tiny in-process async concurrency gate. acquire() resolves with a release fn
// when a slot is free; if none frees within timeoutMs it rejects with
// 'semaphore_timeout'. FIFO among waiters. No external deps.

export interface Semaphore {
  acquire(timeoutMs: number): Promise<() => void>;
}

export function createSemaphore(max: number): Semaphore {
  let inUse = 0;
  const waiters: Array<{ resolve: (release: () => void) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  // Hand each acquirer its OWN release closure, guarded so a double-call is a
  // no-op. A shared release that decremented unconditionally would let a
  // caller who released twice (or in both a catch and a finally) drive inUse
  // below the real occupancy and admit more than `max` in flight - silently
  // defeating the bound. Idempotency makes the primitive safe to reuse.
  const grant = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inUse--;
      const next = waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        inUse++;
        next.resolve(grant());
      }
    };
  };

  return {
    acquire(timeoutMs: number): Promise<() => void> {
      if (inUse < max) {
        inUse++;
        return Promise.resolve(grant());
      }
      return new Promise<() => void>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const i = waiters.indexOf(entry);
            if (i >= 0) waiters.splice(i, 1);
            reject(new Error('semaphore_timeout'));
          }, timeoutMs),
        };
        waiters.push(entry);
      });
    },
  };
}
