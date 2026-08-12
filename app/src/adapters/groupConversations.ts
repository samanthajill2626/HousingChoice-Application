// Twilio Conversations adapter - the "rail" behind a NATIVE group text
// (group-texting spec 6.1/6.2). Vendor SDK imports live here and nowhere else
// (adapters/README.md); services and jobs depend on `GroupConversationsPort`.
//
// THE PARTICIPANT SHAPE IS THE WHOLE TRICK, and getting it wrong costs an hour
// with a misleading error, so it is spelled out (verified LIVE on the dev
// account 2026-08-11, spike addendum):
//   - the BUSINESS number is its OWN participant carrying ONLY
//     MessagingBinding.ProjectedAddress - no identity, no address, no proxy;
//   - each MEMBER is a SEPARATE participant carrying ONLY
//     MessagingBinding.Address - no proxy address, no projected address.
// Combining an address and a projected address on ONE participant returns
// `50407 Invalid messaging binding address`, which reads like a bad phone
// number and is not one.
//
// ALWAYS pin MessagingServiceSid to the CAMPAIGN-BEARING service
// (TWILIO_MESSAGING_SERVICE_SID). Omitting it attributes the traffic to the
// Conversations DEFAULT service, which carries no A2P campaign (spike F8) - an
// A2P hazard, not a cosmetic detail.
//
// Outbound posts deliberately do NOT set X-Twilio-Webhook-Enabled: delivery
// receipts flow without it (spike A3/F3 and the addendum's live outbound run),
// and setting it would add our OWN posts back as onMessageAdded echoes on the
// one shared webhook the guardrail cross-check reads (spec 15.1 / 16.1).
import twilio from 'twilio';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { createRedirectingHttpClient } from './twilioHttpClient.js';
import { SmsSendingDisabledError } from './messaging.js';

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/** A Conversation (the rail) as the app cares about it. */
export interface GroupConversationRef {
  /** CHxx. */
  conversationSid: string;
  /** Our conversationId - the deterministic, non-PII UniqueName. */
  uniqueName?: string;
  /** `initializing` | `active` | `inactive` | `closed`. */
  state?: string;
}

/** One participant of the rail. Exactly ONE of the two address fields is set. */
export interface GroupParticipantRef {
  /** MBxx - the join key every per-member delivery receipt carries. */
  participantSid: string;
  /** A MEMBER's handset, E.164 (MessagingBinding.Address). */
  address?: string;
  /** The BUSINESS number (MessagingBinding.ProjectedAddress). */
  projectedAddress?: string;
}

/** A member Twilio refused to attach (50407-class), reported per row. */
export interface GroupParticipantFailure {
  address: string;
  errorCode?: string;
  message: string;
}

export interface CreateGroupConversationInput {
  /** Deterministic, non-PII UniqueName = our conversationId (spec 6.1). */
  uniqueName: string;
  /** Optional human label; never PII. */
  friendlyName?: string;
  /** The business number, attached as the PROJECTED address participant. */
  businessNumber: string;
  /** Member handsets, E.164 - each becomes an ADDRESS-only participant. */
  members: string[];
}

export interface CreateGroupConversationResult {
  conversation: GroupConversationRef;
  /** Read back from Twilio after attach - the source of the MBxx map. */
  participants: GroupParticipantRef[];
  /** Empty on the bulk path; populated by the individual-add fallback. */
  failures: GroupParticipantFailure[];
}

export interface PostGroupMessageInput {
  conversationSid: string;
  /** The business number itself - the unattached projected address (spike F3). */
  author: string;
  body: string;
}

export interface PostGroupMessageResult {
  /** IMxx - persisted as the message row's provider sid. */
  messageSid: string;
  index?: number;
  /** ISO 8601. */
  dateCreated: string;
}

/**
 * The seam services depend on. S6's `ensureGroupRail` owns create/adopt;
 * `groupSend` owns the post; both read participants to (re)build the MBxx map.
 */
export interface GroupConversationsPort {
  createConversationWithParticipants(
    input: CreateGroupConversationInput,
  ): Promise<CreateGroupConversationResult>;
  /** The adopt half of adopt-or-create: undefined when no such rail exists. */
  fetchByUniqueName(uniqueName: string): Promise<GroupConversationRef | undefined>;
  postGroupMessage(input: PostGroupMessageInput): Promise<PostGroupMessageResult>;
  fetchParticipants(conversationSid: string): Promise<GroupParticipantRef[]>;
  /**
   * ATTACH MEMBERS TO AN EXISTING RAIL - the repair operation.
   *
   * Without it, a partially-attached rail was PERMANENT: the individual-add
   * fallback can attach 8 of 9 when one add throws (a 429 or a 5xx), and every
   * retry then adopts the same Conversation by UniqueName, re-reads the same
   * incomplete participant list, fails MB-map validation, and records
   * `rail_failed` again - forever. Spec 14 makes "zero UNRESOLVED rail
   * failures" a hard cutover gate over 132 real threads, so one throttled add
   * on migration day stranded a thread with no in-app remedy at all.
   *
   * Returns the members Twilio refused, per address, exactly like the create
   * path's `failures` - never throws for a per-member refusal, because the
   * caller's job is to report which member could not be attached.
   */
  addParticipants(
    conversationSid: string,
    addresses: string[],
  ): Promise<GroupParticipantFailure[]>;
}

/**
 * No Conversations rail exists in this process at all (the console driver -
 * local dev with no Twilio account). Distinct from a Twilio failure: nothing
 * was attempted, so the caller records the thread as rail-LESS rather than
 * rail-FAILED, and a group send refuses cleanly instead of persisting a message
 * that never left.
 */
export class GroupConversationsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Documented cap: 10 participants per group conversation (research report 4).
 * Our projected address consumes one, so 9 outside members is the sendable
 * bound the composer and `groupSend` enforce. Above 10 total the bulk
 * ConversationWithParticipants create is not available and the individual-add
 * path is used - which is unreachable while the >9 refusal holds.
 */
export const MAX_RAIL_PARTICIPANTS = 10;

// ---------------------------------------------------------------------------
// Vendor-shape structural type (test seam)
// ---------------------------------------------------------------------------

interface ConversationInstanceLike {
  sid: string;
  uniqueName?: string | null;
  state?: string | null;
  /**
   * Twilio's auto-close/auto-inactive timers. Spec 6.1 says ASSERT, DO NOT SET:
   * we never send them, and the account default is null (spike snapshot
   * conversations-global-config.json). Read here only so a configured timer is
   * noticed the moment a rail is built, rather than months later when every
   * rail has quietly auto-closed and a staff send is the first thing to fail.
   */
  timers?: Record<string, unknown> | null;
}

interface ParticipantInstanceLike {
  sid: string;
  messagingBinding?: unknown;
}

interface ConversationMessageInstanceLike {
  sid: string;
  index?: number | null;
  dateCreated?: Date | null;
}

interface ConversationContextLike {
  fetch(): Promise<ConversationInstanceLike>;
  messages: {
    create(params: { author?: string; body?: string }): Promise<ConversationMessageInstanceLike>;
  };
  participants: {
    create(params: Record<string, string | undefined>): Promise<ParticipantInstanceLike>;
    list(params?: { limit?: number }): Promise<ParticipantInstanceLike[]>;
  };
}

/**
 * The slice of twilio v6's `client.conversations.v1` this adapter uses. Same
 * discipline as `TwilioClientLike` in messaging.ts: a structural type so tests
 * inject a four-method fake while the real SDK client remains assignable.
 */
export interface TwilioConversationsClientLike {
  conversations: {
    v1: {
      conversations: ((sidOrUniqueName: string) => ConversationContextLike) & {
        create(params: {
          uniqueName?: string;
          friendlyName?: string;
          messagingServiceSid?: string;
        }): Promise<ConversationInstanceLike>;
      };
      conversationWithParticipants: {
        create(params: {
          uniqueName?: string;
          friendlyName?: string;
          messagingServiceSid?: string;
          participant?: string[];
        }): Promise<ConversationInstanceLike>;
      };
    };
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Participant JSON for the ConversationWithParticipants bulk create. The API
 * takes each participant as a JSON string whose keys are the RESOURCE's
 * snake_case names (`messaging_binding.address`), not the SDK's camelCase
 * create-parameter names.
 */
function participantJson(binding: Record<string, string>): string {
  return JSON.stringify({ messaging_binding: binding });
}

/** Twilio error code (number or string) off an unknown thrown value. */
function twilioErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return String(code);
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return undefined;
}

/** HTTP status off an unknown thrown value (twilio errors carry `status`). */
function twilioStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read an address out of a participant's `messagingBinding`, camel OR snake. */
function bindingField(binding: unknown, camel: string, snake: string): string | undefined {
  if (typeof binding !== 'object' || binding === null) return undefined;
  const record = binding as Record<string, unknown>;
  const value = record[camel] ?? record[snake];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toParticipantRef(p: ParticipantInstanceLike): GroupParticipantRef {
  const address = bindingField(p.messagingBinding, 'address', 'address');
  const projected = bindingField(p.messagingBinding, 'projectedAddress', 'projected_address');
  return {
    participantSid: p.sid,
    ...(address !== undefined && { address }),
    ...(projected !== undefined && { projectedAddress: projected }),
  };
}

function toConversationRef(c: ConversationInstanceLike): GroupConversationRef {
  return {
    conversationSid: c.sid,
    ...(typeof c.uniqueName === 'string' && c.uniqueName.length > 0 && { uniqueName: c.uniqueName }),
    ...(typeof c.state === 'string' && c.state.length > 0 && { state: c.state }),
  };
}

// ---------------------------------------------------------------------------
// Twilio driver
// ---------------------------------------------------------------------------

export interface TwilioGroupConversationsDriverDeps {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  /** The CAMPAIGN-BEARING messaging service (MGxxx) every rail is pinned to. */
  messagingServiceSid: string;
  /**
   * A2P kill switch (config.smsSendingEnabled). `false` refuses every POST
   * before it reaches Twilio. Rail CREATION stays allowed: creating a
   * Conversation and attaching participants transmits nothing to any handset
   * (spike F3 proved it silent), so it emits no unregistered-A2P traffic.
   */
  sendingEnabled?: boolean;
  /** Dev/test only - redirects REST to the fake-twilio host. */
  apiBaseUrl?: string;
  /** Test seam. */
  client?: TwilioConversationsClientLike;
  logger?: Logger;
}

export class TwilioGroupConversationsDriver implements GroupConversationsPort {
  private readonly client: TwilioConversationsClientLike;
  private readonly log: Logger;

  constructor(private readonly deps: TwilioGroupConversationsDriverDeps) {
    // Same construction as TwilioMessagingDriver: API key SID/secret for REST
    // (never the auth token, which is webhook HMAC only), and the SAME
    // createRedirectingHttpClient seam so hermetic lanes reach fake-twilio with
    // the production code path exercised verbatim.
    this.client =
      deps.client ??
      twilio(deps.apiKeySid, deps.apiKeySecret, {
        accountSid: deps.accountSid,
        ...(deps.apiBaseUrl !== undefined && {
          httpClient: createRedirectingHttpClient({ baseUrl: deps.apiBaseUrl }),
        }),
      });
    this.log = deps.logger ?? defaultLogger;
    if (!deps.messagingServiceSid.startsWith('MG')) {
      // Log-only (never a boot throw): the fake-twilio stack uses synthetic
      // sids. A wrong-but-present value would silently attribute group traffic
      // to the campaign-less Conversations default service (spike F8).
      this.log.warn(
        { event: 'group_rail_messaging_service_suspect' },
        'group rail messaging service SID does not look like an MGxxx - group traffic may miss the A2P campaign',
      );
    }
  }

  async createConversationWithParticipants(
    input: CreateGroupConversationInput,
  ): Promise<CreateGroupConversationResult> {
    const total = input.members.length + 1;
    const participants = [
      // The business number FIRST: its own participant, projected address only.
      participantJson({ projected_address: input.businessNumber }),
      ...input.members.map((address) => participantJson({ address })),
    ];

    if (total <= MAX_RAIL_PARTICIPANTS) {
      try {
        const created = await this.client.conversations.v1.conversationWithParticipants.create({
          uniqueName: input.uniqueName,
          ...(input.friendlyName !== undefined && { friendlyName: input.friendlyName }),
          messagingServiceSid: this.deps.messagingServiceSid,
          participant: participants,
        });
        const attached = await this.fetchParticipants(created.sid);
        this.assertNoTimers(created);
        this.log.info(
          { conversationSid: created.sid, participantCount: attached.length },
          'group rail created (ConversationWithParticipants)',
        );
        return { conversation: toConversationRef(created), participants: attached, failures: [] };
      } catch (err) {
        // A UNIQUENAME CONFLICT IS NOT A PARTICIPANT PROBLEM. The fallback
        // below re-creates under the SAME UniqueName and fails identically, so
        // falling through would cost a round trip and - worse - leave a
        // "falling back to individual participant adds" breadcrumb for what is
        // actually "this rail already exists". Re-throw and let
        // ensureGroupRail's adopt-by-UniqueName handle it on the retry, which
        // is the same end state the fallback reached anyway.
        const code = twilioErrorCode(err);
        if (code === '50353' || twilioStatus(err) === 409) {
          this.log.warn(
            { event: 'group_rail_unique_name_conflict', errorCode: code },
            'group rail create refused: the UniqueName is already taken - a concurrent claimant created this rail',
          );
          throw err;
        }
        // Otherwise the bulk create is all-or-nothing: ONE rail-ineligible
        // member fails the whole request with no per-member detail. Fall back to
        // individual adds so the report can NAME the member Twilio refused
        // (spec 6.1).
        this.log.warn(
          {
            event: 'group_rail_bulk_create_failed',
            errorCode: code,
            memberCount: input.members.length,
          },
          'group rail bulk create failed - falling back to individual participant adds',
        );
      }
    }

    return this.createWithIndividualAdds(input);
  }

  private async createWithIndividualAdds(
    input: CreateGroupConversationInput,
  ): Promise<CreateGroupConversationResult> {
    const conversation = await this.client.conversations.v1.conversations.create({
      uniqueName: input.uniqueName,
      ...(input.friendlyName !== undefined && { friendlyName: input.friendlyName }),
      messagingServiceSid: this.deps.messagingServiceSid,
    });
    const adds: { address: string; params: Record<string, string | undefined> }[] = [
      {
        address: input.businessNumber,
        params: { 'messagingBinding.projectedAddress': input.businessNumber },
      },
      ...input.members.map((address) => ({
        address,
        params: { 'messagingBinding.address': address },
      })),
    ];
    const failures = await this.attach(conversation.sid, adds);
    const attached = await this.fetchParticipants(conversation.sid);
    return { conversation: toConversationRef(conversation), participants: attached, failures };
  }

  /** One participant create per entry, collecting per-member refusals. */
  private async attach(
    conversationSid: string,
    adds: { address: string; params: Record<string, string | undefined> }[],
  ): Promise<GroupParticipantFailure[]> {
    const context = this.client.conversations.v1.conversations(conversationSid);
    const failures: GroupParticipantFailure[] = [];
    for (const add of adds) {
      try {
        await context.participants.create(add.params);
      } catch (err) {
        const code = twilioErrorCode(err);
        failures.push({
          address: add.address,
          ...(code !== undefined && { errorCode: code }),
          message: errorMessage(err),
        });
        // PII (doc 9): the address is NEVER logged - the failure record carries
        // it to the caller's report, which is not a log sink.
        this.log.warn(
          { event: 'group_rail_participant_add_failed', errorCode: code },
          'group rail participant add refused by Twilio',
        );
      }
    }
    return failures;
  }

  async addParticipants(
    conversationSid: string,
    addresses: string[],
  ): Promise<GroupParticipantFailure[]> {
    // MEMBERS ONLY, never a projected address: the business number is attached
    // once at create time, and re-adding it would be a 50407-class refusal on
    // an otherwise healthy repair.
    return this.attach(
      conversationSid,
      addresses.map((address) => ({ address, params: { 'messagingBinding.address': address } })),
    );
  }

  async fetchByUniqueName(uniqueName: string): Promise<GroupConversationRef | undefined> {
    try {
      // A UniqueName addresses the resource in place of its SID.
      const found = await this.client.conversations.v1.conversations(uniqueName).fetch();
      return toConversationRef(found);
    } catch (err) {
      if (twilioStatus(err) === 404 || twilioErrorCode(err) === '20404') return undefined;
      // Anything else (auth, 5xx) must NOT read as "no rail exists" - that would
      // turn an outage into a duplicate-rail storm.
      throw err;
    }
  }

  /**
   * "No timers (account default null) - ASSERT, DO NOT SET" (spec 6.1). We
   * never send timers; nothing verified they were absent (fix wave 5,
   * conformance F2). If an inactive/closed timer is ever configured on the
   * Conversations service or account, EVERY rail auto-closes on a schedule and
   * the first thing to notice is a staff send failing weeks later - because
   * `ensureGroupRail` returns a stored rail without re-reading Twilio state.
   * The created Conversation echoes its effective timers, so the assertion is
   * free: no extra call, WARN only, never a refusal (the rail is real and
   * usable today; the timer is an operator problem).
   */
  private assertNoTimers(created: ConversationInstanceLike): void {
    const timers = created.timers;
    if (timers === undefined || timers === null) return;
    const set = Object.entries(timers).filter(([, v]) => v !== null && v !== undefined);
    if (set.length === 0) return;
    this.log.warn(
      {
        event: 'group_rail_timers_configured',
        conversationSid: created.sid,
        timers: set.map(([k]) => k),
      },
      'the Conversations service has auto-close/auto-inactive TIMERS configured - group rails will close themselves and staff sends will start failing (spec 6.1 expects none)',
    );
  }

  async postGroupMessage(input: PostGroupMessageInput): Promise<PostGroupMessageResult> {
    // A2P kill switch (spec invariant 13.7), enforced INSIDE the adapter so no
    // direct-adapter caller can bypass it. Same error class the existing
    // kill-switch consumers already catch (adapters/messaging.ts).
    if (this.deps.sendingEnabled === false) {
      this.log.warn(
        { event: 'sms_sending_disabled', conversationSid: input.conversationSid },
        'group send refused: SMS sending is disabled (SMS_SENDING_ENABLED) - pre-A2P kill-switch',
      );
      throw new SmsSendingDisabledError(
        'SMS sending is disabled (SMS_SENDING_ENABLED) - refusing to post a group message before A2P approval',
      );
    }
    // NO xTwilioWebhookEnabled: see the module header.
    let message;
    try {
      message = await this.client.conversations.v1
        .conversations(input.conversationSid)
        .messages.create({ author: input.author, body: input.body });
    } catch (err) {
      // A CLOSED (or vanished) RAIL IS AN ACTIONABLE REFUSAL, NOT A 500 (fix
      // wave 5, conformance F2). Nothing asserts the account/service
      // conversation timers, and `ensureGroupRail` returns a stored rail
      // WITHOUT re-reading Twilio whenever the sid is stamped and the map covers
      // the roster - so if an inactive/closed timer is ever configured on the
      // Conversations service, every rail eventually auto-closes and the FIRST
      // thing that notices is a staff send. Untranslated it surfaced as a bare
      // 500 that tells staff nothing; translated, the send route's existing
      // `group_rail_unavailable` mapping says what happened, and the ensure path
      // re-detects the closed state on the next attempt.
      const code = twilioErrorCode(err);
      const status = twilioStatus(err);
      if (status === 409 || status === 404 || code === '50353' || code === '20404') {
        this.log.warn(
          { event: 'group_rail_post_refused', conversationSid: input.conversationSid, code, status },
          'Conversations refused a post to this rail - it is closed, or it no longer exists',
        );
        throw new GroupConversationsUnavailableError(
          `the Conversations rail refused this post (${code ?? status ?? 'unknown'}) - it is closed or gone`,
        );
      }
      throw err;
    }
    const dateCreated =
      message.dateCreated instanceof Date ? message.dateCreated.toISOString() : new Date().toISOString();
    // PII (doc 9): SID + length only, never the body.
    this.log.info(
      {
        conversationSid: input.conversationSid,
        providerSid: message.sid,
        bodyLength: input.body.length,
      },
      'group conversation message posted',
    );
    return {
      messageSid: message.sid,
      ...(typeof message.index === 'number' && { index: message.index }),
      dateCreated,
    };
  }

  async fetchParticipants(conversationSid: string): Promise<GroupParticipantRef[]> {
    // ONE OVER THE CAP, deliberately. Listing exactly MAX_RAIL_PARTICIPANTS
    // would silently TRUNCATE a rail that somehow holds more (a hand-edited
    // Conversation, a future cap change), and the caller would then read the
    // short map as an MB-map "mismatch" - the safe direction, but a diagnosis
    // that names the wrong cause. Reading one extra makes the over-cap case
    // detectable, and says so.
    const list = await this.client.conversations.v1
      .conversations(conversationSid)
      .participants.list({ limit: MAX_RAIL_PARTICIPANTS + 1 });
    if (list.length > MAX_RAIL_PARTICIPANTS) {
      this.log.warn(
        { event: 'group_rail_over_cap', conversationSid, participantCount: list.length },
        'group rail holds more participants than the documented cap - the map may be incomplete',
      );
    }
    return list.map(toParticipantRef);
  }
}

// ---------------------------------------------------------------------------
// Console driver - local dev with no Twilio account
// ---------------------------------------------------------------------------

/**
 * There is no Conversations service to talk to, so this driver creates NOTHING
 * and posts NOTHING - group threads stay RAIL-LESS on a console stack.
 *
 * It refuses rather than returning a synthetic `CHconsole-` sid the way the
 * console MESSAGING driver returns `SMconsole-`, and that difference is
 * deliberate: a synthetic rail sid would be PERSISTED on the thread as proof of
 * a rail that does not exist, and a synthetic IMxx would persist a message row
 * for a send that never left (whose staleness alarm would then fire forever).
 * A typed refusal is the honest signal, and every caller already has to handle
 * "no rail".
 */
export class ConsoleGroupConversationsDriver implements GroupConversationsPort {
  private readonly log: Logger;

  constructor(deps: { logger?: Logger } = {}) {
    this.log = deps.logger ?? defaultLogger;
  }

  private unavailable(what: string): GroupConversationsUnavailableError {
    this.log.info(
      { event: 'group_rail_unavailable', operation: what },
      'console messaging driver: no Conversations rail - group texting is unavailable locally',
    );
    return new GroupConversationsUnavailableError(
      `console messaging driver: ${what} is unavailable (no Twilio Conversations service)`,
    );
  }

  async createConversationWithParticipants(
    _input: CreateGroupConversationInput,
  ): Promise<CreateGroupConversationResult> {
    throw this.unavailable('group rail creation');
  }

  async fetchByUniqueName(_uniqueName: string): Promise<GroupConversationRef | undefined> {
    // REFUSE, like every other method here. Returning `undefined` reads as "no
    // such rail exists", which sends ensureGroupRail down the create path to the
    // throw below - the same end state, one wasted Twilio-shaped round trip, and
    // a `rail_failed` reason that names creation rather than the real cause.
    throw this.unavailable('group rail lookup');
  }

  async postGroupMessage(_input: PostGroupMessageInput): Promise<PostGroupMessageResult> {
    throw this.unavailable('group message post');
  }

  async fetchParticipants(_conversationSid: string): Promise<GroupParticipantRef[]> {
    return [];
  }

  async addParticipants(
    _conversationSid: string,
    _addresses: string[],
  ): Promise<GroupParticipantFailure[]> {
    throw this.unavailable('group rail participant add');
  }
}

// ---------------------------------------------------------------------------
// Factory - driver selection from config (MESSAGING_DRIVER)
// ---------------------------------------------------------------------------

export interface CreateGroupConversationsAdapterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Test seam: injected into the Twilio driver. */
  twilioClient?: TwilioConversationsClientLike;
}

export function createGroupConversationsAdapter(
  deps: CreateGroupConversationsAdapterDeps = {},
): GroupConversationsPort {
  const config = deps.config ?? loadConfig();
  if (config.messagingDriver === 'console') {
    return new ConsoleGroupConversationsDriver({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  }
  // loadConfig() fail-fasts these for MESSAGING_DRIVER=twilio; this guard covers
  // hand-built AppConfig objects (mirrors createMessagingAdapter).
  if (
    !config.twilioAccountSid ||
    !config.twilioApiKeySid ||
    !config.twilioApiKeySecret ||
    !config.twilioMessagingServiceSid
  ) {
    throw new Error(
      'createGroupConversationsAdapter: messagingDriver=twilio but twilio* config is incomplete',
    );
  }
  return new TwilioGroupConversationsDriver({
    accountSid: config.twilioAccountSid,
    apiKeySid: config.twilioApiKeySid,
    apiKeySecret: config.twilioApiKeySecret,
    messagingServiceSid: config.twilioMessagingServiceSid,
    sendingEnabled: config.smsSendingEnabled,
    ...(config.twilioApiBaseUrl !== undefined && { apiBaseUrl: config.twilioApiBaseUrl }),
    ...(deps.twilioClient !== undefined && { client: deps.twilioClient }),
    ...(deps.logger !== undefined && { logger: deps.logger }),
  });
}
