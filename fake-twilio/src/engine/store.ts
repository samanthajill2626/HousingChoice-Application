// fake-twilio/src/engine/store.ts
import type { DeliveryState, Thread, ThreadMessage } from './types.js';

/** In-memory conversation store, keyed by the party (non-app) E.164 number. */
export class ConversationStore {
  private readonly threads = new Map<string, Thread>();
  private readonly bySid = new Map<string, ThreadMessage>();

  append(partyNumber: string, message: ThreadMessage): void {
    let thread = this.threads.get(partyNumber);
    if (!thread) {
      thread = { partyNumber, messages: [] };
      this.threads.set(partyNumber, thread);
    }
    thread.messages.push(message);
    this.bySid.set(message.sid, message);
  }

  updateState(sid: string, state: DeliveryState): ThreadMessage | undefined {
    const m = this.bySid.get(sid);
    if (!m) return undefined;
    m.state = state;
    // `updatedAt` is stamped by the engine (which owns the clock), not here.
    return m;
  }

  thread(partyNumber: string): Thread {
    return this.threads.get(partyNumber) ?? { partyNumber, messages: [] };
  }

  listThreads(): Thread[] {
    return [...this.threads.values()];
  }

  reset(): void {
    this.threads.clear();
    this.bySid.clear();
  }
}
