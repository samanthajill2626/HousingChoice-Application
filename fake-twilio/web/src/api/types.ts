// Wire types for the fake-phones UI.
//
// These MIRROR the engine's types (`fake-twilio/src/engine/types.ts`) and the
// `EngineEvent` union (`fake-twilio/src/engine/engine.ts`). The UI is a separate
// package by design, so the shapes are re-declared here rather than imported.
// If the engine types change, update BOTH places.

export type Role = 'landlord' | 'tenant' | 'pm' | 'staff';

export type DeliveryState = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/** How the fake should drive an outbound message's status callbacks. */
export interface DeliveryProfile {
  kind: 'normal' | 'stall' | 'fail';
  /** For kind==='stall': the last state to emit before stopping (default 'sent'). */
  stallAt?: DeliveryState;
  /** For kind==='fail': 'failed' | 'undelivered' (default 'failed') + an ErrorCode. */
  failState?: 'failed' | 'undelivered';
  errorCode?: string;
}

export interface Persona {
  id: string;
  label: string;
  role: Role;
  /** E.164, e.g. +15550100001. */
  number: string;
  /** Optional pointer to seeded app data (contactId), for humans reading the roster. */
  seededRef?: string;
  adHoc: boolean;
}

export interface ThreadMessage {
  /** Twilio-style SID: SM... (or MM... when media is present). */
  sid: string;
  direction: 'inbound' | 'outbound';
  /** Sender E.164 (app number for outbound, party number for inbound). */
  from: string;
  /** Recipient E.164. */
  to: string;
  body?: string;
  mediaUrls?: string[];
  state: DeliveryState;
  /** Twilio ErrorCode, set only when the message resolved to a failure state. */
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
}

/** A conversation thread between the app and exactly one party number. */
export interface Thread {
  /** The party's E.164 number (the non-app side). */
  partyNumber: string;
  messages: ThreadMessage[];
}

// ---- Control API DTOs ----
export interface SendAsPartyInput {
  /** Party number (must be a known persona or ad-hoc). */
  from: string;
  /** App number the text is sent to (defaults to the configured app number). */
  to?: string;
  body?: string;
  mediaUrls?: string[];
}

export interface SetDeliveryOutcomeInput {
  /** Party number whose NEXT outbound message uses this profile. */
  partyNumber: string;
  profile: DeliveryProfile;
}

export interface AddAdHocInput {
  label: string;
  role: Role;
  /** Optional explicit E.164; otherwise the registry mints one. */
  number?: string;
}

// ---- Live event union (mirrors `EngineEvent` in engine.ts) ----
export type EngineEvent =
  | { type: 'message.appended'; partyNumber: string; message: ThreadMessage }
  | { type: 'message.updated'; partyNumber: string; message: ThreadMessage }
  | { type: 'persona.added'; persona: Persona }
  | { type: 'reset' };
