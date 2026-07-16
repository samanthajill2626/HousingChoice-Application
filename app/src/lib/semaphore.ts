// A tiny in-process async concurrency gate. acquire() resolves with a release fn
// when a slot is free; if none frees within timeoutMs it rejects with
// 'semaphore_timeout'. FIFO among waiters. No external deps.

export interface Semaphore {
  acquire(timeoutMs: number): Promise<() => void>;
}

export function createSemaphore(max: number): Semaphore {
  let inUse = 0;
  const waiters: Array<{ resolve: (release: () => void) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  const release = (): void => {
    inUse--;
    const next = waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      inUse++;
      next.resolve(release);
    }
  };

  return {
    acquire(timeoutMs: number): Promise<() => void> {
      if (inUse < max) {
        inUse++;
        return Promise.resolve(release);
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
