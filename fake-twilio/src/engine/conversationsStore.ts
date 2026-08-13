// fake-twilio/src/engine/conversationsStore.ts
//
// In-memory Twilio Conversations state: the RAIL behind a native group text.
// Same discipline as GroupStore (groups.ts) - a Map keyed by the resource id,
// a secondary index for the other way callers address it, and immutable
// snapshot DTOs handed out so a control-API reader can never mutate engine
// state.
//
// TWO ADDRESSING MODES, both real: Twilio lets a UniqueName stand in for a SID
// anywhere a Conversation SID appears, and the adapter's adopt-or-create path
// depends on exactly that (`fetchByUniqueName` does
// `conversations(uniqueName).fetch()`). So the store resolves either.
import type {
  ConversationMessageSnapshot,
  ConversationParticipantSnapshot,
  ConversationSnapshot,
  DeliveryState,
} from './types.js';

export interface ConversationParticipantRecord {
  sid: string;
  address?: string;
  projectedAddress?: string;
  dateCreated: string;
}

export interface ConversationLegRecord {
  participantSid: string;
  address: string;
  channelMessageSid: string;
  state: DeliveryState;
}

export interface ConversationMessageRecord {
  sid: string;
  author?: string;
  body?: string;
  index: number;
  source: 'API' | 'SMS';
  dateCreated: string;
  legs: ConversationLegRecord[];
}

export interface ConversationRecord {
  sid: string;
  uniqueName?: string;
  friendlyName?: string;
  messagingServiceSid?: string;
  state: string;
  dateCreated: string;
  participants: ConversationParticipantRecord[];
  messages: ConversationMessageRecord[];
}

/** Thrown when a create reuses a UniqueName - Twilio's real 409/50353. */
export class DuplicateUniqueNameError extends Error {
  constructor(uniqueName: string) {
    super(`Conversation with UniqueName ${uniqueName} already exists`);
    this.name = new.target.name;
  }
}

export class ConversationsStore {
  private readonly bySid = new Map<string, ConversationRecord>();
  private readonly byUniqueName = new Map<string, string>();

  create(input: {
    sid: string;
    uniqueName?: string;
    friendlyName?: string;
    messagingServiceSid?: string;
    dateCreated: string;
  }): ConversationRecord {
    if (input.uniqueName !== undefined && this.byUniqueName.has(input.uniqueName)) {
      throw new DuplicateUniqueNameError(input.uniqueName);
    }
    const record: ConversationRecord = {
      sid: input.sid,
      ...(input.uniqueName !== undefined && { uniqueName: input.uniqueName }),
      ...(input.friendlyName !== undefined && { friendlyName: input.friendlyName }),
      ...(input.messagingServiceSid !== undefined && {
        messagingServiceSid: input.messagingServiceSid,
      }),
      // Real Conversations resources go `initializing` then `active`; the fake
      // reports `active` immediately because nothing here is asynchronous and a
      // rail service that reads `initializing` would refuse a healthy rail.
      state: 'active',
      dateCreated: input.dateCreated,
      participants: [],
      messages: [],
    };
    this.bySid.set(record.sid, record);
    if (record.uniqueName !== undefined) this.byUniqueName.set(record.uniqueName, record.sid);
    return record;
  }

  /** Resolve by SID or by UniqueName - Twilio accepts either in the path. */
  resolve(sidOrUniqueName: string): ConversationRecord | undefined {
    const direct = this.bySid.get(sidOrUniqueName);
    if (direct) return direct;
    const sid = this.byUniqueName.get(sidOrUniqueName);
    return sid === undefined ? undefined : this.bySid.get(sid);
  }

  /**
   * THE CLOSED-STATE SEAM (fix wave 4, H1). Twilio closes a Conversation on its
   * own - an account/service auto-close timer, or an operator in the console -
   * and a closed rail keeps its UniqueName while refusing every post. That is
   * the exact state the app's closed-rail heal has to survive, and there was no
   * way to manufacture it here at all: `create` hard-codes `active` and nothing
   * ever moved it. Without this seam the heal can only be tested against
   * hand-stubbed ensurers, which is how the defect stayed invisible for three
   * waves - the tests asserted the outcome the service could not produce.
   */
  setState(sidOrUniqueName: string, state: string): ConversationRecord | undefined {
    const record = this.resolve(sidOrUniqueName);
    if (!record) return undefined;
    record.state = state;
    return record;
  }

  remove(sidOrUniqueName: string): boolean {
    const record = this.resolve(sidOrUniqueName);
    if (!record) return false;
    this.bySid.delete(record.sid);
    if (record.uniqueName !== undefined) this.byUniqueName.delete(record.uniqueName);
    return true;
  }

  addParticipant(
    record: ConversationRecord,
    participant: ConversationParticipantRecord,
  ): ConversationParticipantRecord {
    record.participants.push(participant);
    return participant;
  }

  /** The participant carrying the business number (its PROJECTED address). */
  businessParticipant(record: ConversationRecord): ConversationParticipantRecord | undefined {
    return record.participants.find((p) => p.projectedAddress !== undefined);
  }

  /** The address-bearing participants - the members a post fans out to. */
  memberParticipants(record: ConversationRecord): ConversationParticipantRecord[] {
    return record.participants.filter((p) => p.address !== undefined);
  }

  /**
   * The conversation a given handset is a MEMBER of, if any. This is how an
   * inbound carrier group text binds to its rail: the carrier delivers to the
   * business number, Twilio matches the participant, and the message shows up
   * on the Conversation as a `Source: SMS` onMessageAdded.
   */
  findByMemberAddress(address: string): ConversationRecord | undefined {
    for (const record of this.bySid.values()) {
      if (record.participants.some((p) => p.address === address)) return record;
    }
    return undefined;
  }

  appendMessage(record: ConversationRecord, message: ConversationMessageRecord): void {
    record.messages.push(message);
  }

  nextIndex(record: ConversationRecord): number {
    return record.messages.length;
  }

  list(): ConversationRecord[] {
    return [...this.bySid.values()];
  }

  reset(): void {
    this.bySid.clear();
    this.byUniqueName.clear();
  }

  /** Deep-enough copy that a control-API reader cannot mutate engine state. */
  static snapshot(record: ConversationRecord): ConversationSnapshot {
    const participants: ConversationParticipantSnapshot[] = record.participants.map((p) => ({
      sid: p.sid,
      ...(p.address !== undefined && { address: p.address }),
      ...(p.projectedAddress !== undefined && { projectedAddress: p.projectedAddress }),
      dateCreated: p.dateCreated,
    }));
    const messages: ConversationMessageSnapshot[] = record.messages.map((m) => ({
      sid: m.sid,
      ...(m.author !== undefined && { author: m.author }),
      ...(m.body !== undefined && { body: m.body }),
      index: m.index,
      source: m.source,
      dateCreated: m.dateCreated,
      ...(m.legs.length > 0 && { legs: m.legs.map((l) => ({ ...l })) }),
    }));
    return {
      sid: record.sid,
      ...(record.uniqueName !== undefined && { uniqueName: record.uniqueName }),
      ...(record.friendlyName !== undefined && { friendlyName: record.friendlyName }),
      ...(record.messagingServiceSid !== undefined && {
        messagingServiceSid: record.messagingServiceSid,
      }),
      state: record.state,
      participants,
      messages,
      dateCreated: record.dateCreated,
    };
  }
}
