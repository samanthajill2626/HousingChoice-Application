// fake-twilio/src/engine/clock.ts
export interface Clock {
  nowIso(): string;
  /** Schedule a callback after `delayMs`. Returns a cancel function. */
  schedule(delayMs: number, fn: () => void): () => void;
}

/** Production clock: real time + real timers (used by the running service). */
export class RealClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
  schedule(delayMs: number, fn: () => void): () => void {
    const t = setTimeout(fn, delayMs);
    return () => clearTimeout(t);
  }
}

/** Deterministic clock for tests: time advances only on advance()/flush(). */
export class ManualClock implements Clock {
  private ms: number;
  private queue: Array<{ at: number; fn: () => void }> = [];
  constructor(startIso: string) {
    this.ms = Date.parse(startIso);
  }
  nowIso(): string {
    return new Date(this.ms).toISOString();
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
  schedule(delayMs: number, fn: () => void): () => void {
    const entry = { at: delayMs, fn };
    this.queue.push(entry);
    return () => {
      this.queue = this.queue.filter((e) => e !== entry);
    };
  }
  /** Run all queued callbacks in ascending delay order (then clear the queue). */
  flush(): void {
    const pending = [...this.queue].sort((a, b) => a.at - b.at);
    this.queue = [];
    for (const e of pending) e.fn();
  }
}
