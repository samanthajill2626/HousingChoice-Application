// Test harness for the M1.1 Twilio webhook golden suite: an app built via
// buildApp() with injected in-memory fakes (no DynamoDB, no network), plus a
// signed-form-POST builder that computes REAL HMAC-SHA1 X-Twilio-Signature
// values with the twilio package — signature verification is exercised for
// real, never mocked out.
import { Readable } from 'node:stream';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { Express } from 'express';
import request, { type Test } from 'supertest';
import twilio from 'twilio';
import { buildApp } from '../../src/app.js';
import type { MediaStore } from '../../src/adapters/mediaStore.js';
import type {
  InitiateCallParams,
  MessagingAdapter,
  SendMessageParams,
  SendMessageResult,
} from '../../src/adapters/messaging.js';
import { DEV_SESSION_SECRET_DEFAULT, loadConfig, type AppConfig } from '../../src/lib/config.js';
import { createEventBus, type AppEventName, type EventBus } from '../../src/lib/events.js';
import { createLogger } from '../../src/lib/logger.js';
import type { AuditRepo } from '../../src/repos/auditRepo.js';
import {
  isDeleted,
  phoneRefId,
  PrimaryPhoneRemovalError,
  type ContactFlag,
  type ContactItem,
  type ContactPhone,
  type ContactsRepo,
} from '../../src/repos/contactsRepo.js';
import {
  DEFAULT_ORG_SETTINGS,
  type OrgSettings,
  type SettingsRepo,
} from '../../src/repos/settingsRepo.js';
import {
  toPreview,
  type ConversationItem,
  type ConversationsRepo,
  type ConversationType,
} from '../../src/repos/conversationsRepo.js';
import {
  allowedPriorCallStatuses,
  allowedPriorStatuses,
  buildTsMsgId,
  type MessageItem,
  type MessagesRepo,
} from '../../src/repos/messagesRepo.js';
import {
  CannotRemovePrimaryLandlordError,
  isDeleted as isUnitDeleted,
  unitContacts,
  type UnitContact,
  type UnitItem,
  type UnitsRepo,
} from '../../src/repos/unitsRepo.js';
import { type PlacementDeadline, type PlacementItem, type PlacementsRepo } from '../../src/repos/placementsRepo.js';
import {
  buildTsEventId,
  type ActivityEventItem,
  type ActivityEventsRepo,
} from '../../src/repos/activityEventsRepo.js';
import {
  ListingSendNotFoundError,
  type ListingSendItem,
  type ListingSendsRepo,
} from '../../src/repos/listingSendsRepo.js';
import {
  type ContactVocabulary,
  type ContactVocabularyRepo,
} from '../../src/repos/contactVocabularyRepo.js';
import {
  type BroadcastItem,
  type BroadcastsRepo,
  type BroadcastStats,
  zeroStats,
} from '../../src/repos/broadcastsRepo.js';
import {
  ConditionalCheckFailedException as TourConditionalCheckFailedException,
  type TourItem,
  type ToursRepo,
} from '../../src/repos/toursRepo.js';
import { type TourReminderItem, type TourRemindersRepo } from '../../src/repos/tourRemindersRepo.js';
import { type PoolNumbersService } from '../../src/services/poolNumbers.js';
import {
  type PushNotification,
  type PushService,
  type SendToUserResult,
} from '../../src/services/pushService.js';
import {
  createAudienceResolutionService,
  type AudienceResolutionService,
} from '../../src/services/audienceResolution.js';
import { type SystemStatusService } from '../../src/services/systemStatus.js';
import { createSendMessageService } from '../../src/services/sendMessage.js';
import {
  adminUserItem,
  makeFakeUsersRepo,
  testUserItem,
  type FakeUsersRepo,
} from './authSession.js';
import { createLogCapture, type LogCapture } from './logCapture.js';

export const ORIGIN_SECRET = 'test-origin-secret';
export const AUTH_TOKEN = 'test-twilio-auth-token';
export const PUBLIC_BASE_URL = 'https://dxxxx.cloudfront.example';
export const OUR_NUMBER = '+15550009999';
export const TENANT_PHONE = '+15550100001';

// ---------------------------------------------------------------------------
// In-memory fakes — mirror the contractual semantics the routes rely on:
// SID-conditional append dedupe, forward-only status machine, byPhone lookup.
// ---------------------------------------------------------------------------

export interface FakeWorld {
  conversations: Map<string, ConversationItem>;
  messages: MessageItem[];
  /** jobIds recorded by putJobExecutionMarker (the M1.2 execution guard). */
  jobExecutionMarkers: Map<string, string>;
  /** Relay-recipient SID pointers (M1.7): providerSid → source msg + member. */
  relaySidPointers: Map<string, { conversationId: string; tsMsgId: string; memberKey: string }>;
  contacts: ContactItem[];
  flagWrites: { contactId: string; flag: ContactFlag; value: boolean }[];
  /** Conversation-level sms_opt_out writes (setSmsOptOut calls), in order. */
  optOutSets: { conversationId: string; value: boolean }[];
  /**
   * Audit events as the REAL repo writes them (M1.4 M2): attribute names match
   * the actual DynamoDB item shape — `event_type` (NOT eventType), a top-level
   * `actorId` lifted from payload.actor (the byActor GSI key), and the nested
   * `payload`. Asserting against this shape exercises what production stores.
   */
  auditEvents: {
    entityKey: string;
    event_type: string;
    actorId?: string;
    payload?: Record<string, unknown>;
  }[];
  touches: { conversationId: string; previewText: string | undefined; ts: string }[];
  /** contactIds actually CREATED by createIfAbsent (M1.2 auto-capture). */
  contactCreates: string[];
  /** conversationIds whose unread counter was bumped, in order (M1.2). */
  unreadIncrements: string[];
  sent: SendMessageParams[];
  /** Outbound calls initiated via adapter.initiateCall (M1.9a), in order. */
  initiatedCalls: InitiateCallParams[];
  mediaPuts: { key: string; contentType?: string; bytes: number }[];
  /** Media URLs that getMediaStream should fail for. */
  failMediaUrls: Set<string>;
  /** Recording URLs that getRecordingStream should fail for (M1.9c). */
  failRecordingUrls: Set<string>;
  /** What mediaStore.put stored, by S3 key — read back by getStream (M1.9c). */
  mediaObjects: Map<string, { body: Buffer; contentType?: string }>;
  /** The bus injected into the app — emit/subscribe like production code. */
  events: EventBus;
  /** Every bus emission, in order (the harness subscribes to both events). */
  emitted: { event: AppEventName; payload: unknown }[];
  conversationsRepo: ConversationsRepo;
  messagesRepo: MessagesRepo;
  contactsRepo: ContactsRepo;
  auditRepo: AuditRepo;
  /** In-memory units (M1.5), keyed by unitId. */
  units: Map<string, UnitItem>;
  unitsRepo: UnitsRepo;
  /** In-memory placements (M1.10), keyed by placementId. */
  placements: Map<string, PlacementItem>;
  placementsRepo: PlacementsRepo;
  /** In-memory activity events (BE2/C2), in insert order. */
  activityEvents: ActivityEventItem[];
  activityEventsRepo: ActivityEventsRepo;
  /** In-memory listing sends (BE4/C4), keyed `${unitId}#${contactId}`. */
  listingSends: ListingSendItem[];
  listingSendsRepo: ListingSendsRepo;
  /** In-memory broadcasts (M1.8a), keyed by broadcastId. */
  broadcasts: Map<string, BroadcastItem>;
  broadcastsRepo: BroadcastsRepo;
  /** In-memory org-settings (M1.4); starts at DEFAULT_ORG_SETTINGS. */
  settings: OrgSettings;
  settingsRepo: SettingsRepo;
  /** Every add() call made on the vocabulary repo (Task 4), in order. */
  vocabularyAdds: Partial<Record<'roles' | 'relationshipRoles' | 'fieldLabels', string[]>>[];
  /** Fake vocabulary repo (Task 4): in-memory union of all add() tokens. */
  vocabularyRepo: ContactVocabularyRepo;
  /** Every pushService.sendToUser call (M1.9b pre-ring/missed-call pushes), in order. */
  pushSends: { userId: string; notification: PushNotification }[];
  /** Fake push service the voice router uses — records sends into pushSends. */
  pushService: PushService;
  adapter: MessagingAdapter;
  mediaStore: MediaStore;
  /** In-memory tours (Tours feature), keyed by tourId. */
  toursMap: Map<string, TourItem>;
  toursRepo: ToursRepo;
  /** In-memory tour reminders (Tours feature, Task 4), keyed by reminderId. */
  tourRemindersMap: Map<string, TourReminderItem>;
  tourRemindersRepo: TourRemindersRepo;
}

export function createFakeWorld(): FakeWorld {
  const conversations = new Map<string, ConversationItem>();
  const messages: MessageItem[] = [];
  const jobExecutionMarkers = new Map<string, string>();
  const relaySidPointers = new Map<
    string,
    { conversationId: string; tsMsgId: string; memberKey: string }
  >();
  const contacts: ContactItem[] = [];
  const flagWrites: FakeWorld['flagWrites'] = [];
  const optOutSets: FakeWorld['optOutSets'] = [];
  const auditEvents: FakeWorld['auditEvents'] = [];
  const touches: FakeWorld['touches'] = [];
  const contactCreates: string[] = [];
  const unreadIncrements: string[] = [];
  const sent: SendMessageParams[] = [];
  const initiatedCalls: InitiateCallParams[] = [];
  const mediaPuts: FakeWorld['mediaPuts'] = [];
  const failMediaUrls = new Set<string>();
  const failRecordingUrls = new Set<string>();
  // What put() stored, keyed by S3 key — so getStream() can read it back (the
  // M1.9c recording round-trip).
  const mediaObjects = new Map<string, { body: Buffer; contentType?: string }>();
  let convCounter = 0;
  let sidCounter = 0;
  let provisionCounter = 0;
  let callCounter = 0;

  const events = createEventBus();
  const emitted: FakeWorld['emitted'] = [];
  events.on('conversation.updated', (payload) => emitted.push({ event: 'conversation.updated', payload }));
  events.on('message.persisted', (payload) => emitted.push({ event: 'message.persisted', payload }));
  events.on('broadcast.updated', (payload) => emitted.push({ event: 'broadcast.updated', payload }));
  events.on('placement.updated', (payload) => emitted.push({ event: 'placement.updated', payload }));

  /** The real repos throw the SDK's conditional-check error — mirror it. */
  const conditionalCheckFailed = (message: string): ConditionalCheckFailedException =>
    new ConditionalCheckFailedException({ message, $metadata: {} });

  const conversationsRepo: ConversationsRepo = {
    async createOrGetByParticipantPhone(phone: string, type: ConversationType) {
      for (const conv of conversations.values()) {
        if (conv.participant_phone === phone && conv.status === 'open') return conv;
      }
      const now = new Date().toISOString();
      const item: ConversationItem = {
        conversationId: `conv-${++convCounter}`,
        participant_phone: phone,
        status: 'open',
        last_activity_at: now,
        type,
        ai_mode: 'auto',
        created_at: now,
      };
      conversations.set(item.conversationId, item);
      return item;
    },
    async getById(conversationId) {
      return conversations.get(conversationId);
    },
    async touchLastActivity(conversationId, previewText, ts) {
      touches.push({ conversationId, previewText, ts });
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`touchLastActivity: no conversation ${conversationId}`);
      conv.status = 'open';
      conv.last_activity_at = ts;
      const preview = toPreview(previewText);
      if (preview !== undefined) conv.last_message_preview = preview;
      return conv;
    },
    async setParticipantsIfAbsent(conversationId, participants) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error(`setParticipantsIfAbsent: conversation not found: ${conversationId}`);
      if (conv.participants !== undefined) return false;
      conv.participants = participants;
      return true;
    },
    async incrementUnread(conversationId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`incrementUnread: no conversation ${conversationId}`);
      conv.unread_count = (conv.unread_count ?? 0) + 1;
      unreadIncrements.push(conversationId);
      return conv.unread_count;
    },
    async resetUnread(conversationId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`resetUnread: no conversation ${conversationId}`);
      conv.unread_count = 0;
      return conv;
    },
    async setAssignment(conversationId, assigneeUserId) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`setAssignment: no conversation ${conversationId}`);
      const previousAssigneeUserId = typeof conv.assignment === 'string' ? conv.assignment : null;
      if (assigneeUserId === null) delete conv.assignment;
      else conv.assignment = assigneeUserId;
      return { conversation: conv, previousAssigneeUserId };
    },
    async listByLastActivity({ status, limit }) {
      const items = [...conversations.values()]
        .filter((c) => c.status === status)
        .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1))
        .slice(0, limit ?? 50);
      return { items };
    },
    async findByParticipantPhone(phone) {
      return [...conversations.values()].filter((c) => c.participant_phone === phone);
    },
    async setType(conversationId, type) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`setType: no conversation ${conversationId}`);
      conv.type = type;
      return conv;
    },
    async applyTriage(conversationId, fields) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`applyTriage: no conversation ${conversationId}`);
      if (fields.type !== undefined) conv.type = fields.type;
      if (fields.displayName !== undefined && fields.displayName !== null) {
        conv.participant_display_name = fields.displayName;
      }
      return conv;
    },
    async setMode(conversationId, mode) {
      const conv = conversations.get(conversationId);
      if (conv) conv.ai_mode = mode;
    },
    async setSmsOptOut(conversationId, value) {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error(`setSmsOptOut: no conversation ${conversationId}`);
      conv.sms_opt_out = value;
      optOutSets.push({ conversationId, value });
    },
    async incrementAutomatedSendCount() {
      return 1; // breaker untested here (covered by sendMessage.test.ts)
    },

    // --- Relay groups (M1.7 / Task 5 owner generalization) ---
    async createRelayGroup({ poolNumber, members, tag, placementId, owner }) {
      const now = new Date().toISOString();
      // Resolve owner (mirrors conversationsRepo.ts logic).
      const resolvedOwner: { type: 'tour' | 'placement' | null; id?: string } =
        owner !== undefined
          ? owner
          : typeof placementId === 'string' && placementId.length > 0
            ? { type: 'placement', id: placementId }
            : { type: null };
      const item: ConversationItem = {
        conversationId: `conv-${++convCounter}`,
        participant_phone: poolNumber,
        pool_number: poolNumber,
        status: 'open',
        last_activity_at: now,
        type: 'relay_group',
        ai_mode: 'manual',
        participants: members,
        created_at: now,
        ...(tag !== undefined && { placement_tag: tag }),
        ...(resolvedOwner.type === 'placement' && { placementId: resolvedOwner.id }),
        ...(resolvedOwner.type !== null && { owner: resolvedOwner }),
      };
      conversations.set(item.conversationId, item);
      return item;
    },
    async getByPoolNumber(poolNumber) {
      for (const conv of conversations.values()) {
        if (conv.pool_number === poolNumber && conv.type === 'relay_group') return conv;
      }
      return undefined;
    },
    async addMember(conversationId, member) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`addMember: no conversation ${conversationId}`);
      const roster = conv.participants ?? [];
      // FIX 3: idempotent on phone; a real change bumps participants_version.
      if (!roster.some((p) => p.phone === member.phone)) {
        conv.participants = [...roster, member];
        conv.participants_version = (conv.participants_version ?? 0) + 1;
      }
      return conv;
    },
    async removeMember(conversationId, phone) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`removeMember: no conversation ${conversationId}`);
      const roster = conv.participants ?? [];
      const next = roster.filter((p) => p.phone !== phone);
      // FIX 3: only a real removal bumps the version (idempotent no-op otherwise).
      if (next.length !== roster.length) {
        conv.participants = next;
        conv.participants_version = (conv.participants_version ?? 0) + 1;
      }
      return conv;
    },
    async setRelayStatus(conversationId, status, poolNumber, expectedStatus) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`setRelayStatus: no conversation ${conversationId}`);
      // FIX 1: honor the optional conditional flip (concurrent close/reopen
      // idempotency) — a precondition mismatch throws like the real repo.
      if (expectedStatus !== undefined && conv.status !== expectedStatus) {
        throw conditionalCheckFailed(
          `setRelayStatus: ${conversationId} expected status ${expectedStatus} but was ${conv.status}`,
        );
      }
      conv.status = status;
      if (poolNumber === null) delete conv.pool_number;
      else conv.pool_number = poolNumber;
      return conv;
    },
    async setRelayMemberOptedOut(conversationId, memberKey, entry) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`setRelayMemberOptedOut: no conversation ${conversationId}`);
      // Merge one slot without clobbering the others (mirrors the targeted SET).
      conv.relay_opted_out_members = { ...(conv.relay_opted_out_members ?? {}), [memberKey]: entry };
    },
    async clearRelayMemberOptedOut(conversationId, memberKey) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`clearRelayMemberOptedOut: no conversation ${conversationId}`);
      if (conv.relay_opted_out_members !== undefined) {
        const { [memberKey]: _removed, ...rest } = conv.relay_opted_out_members;
        conv.relay_opted_out_members = rest;
      }
    },
    async rebindOwner(conversationId, newOwner) {
      const conv = conversations.get(conversationId);
      if (!conv) throw conditionalCheckFailed(`rebindOwner: no conversation ${conversationId}`);
      if (newOwner.type === null) {
        delete conv.owner;
        delete conv.placementId;
      } else if (newOwner.type === 'placement') {
        conv.owner = newOwner;
        conv.placementId = newOwner.id;
      } else {
        conv.owner = newOwner;
        delete conv.placementId;
      }
      return conv;
    },
  };

  const findBySid = (sid: string): MessageItem | undefined =>
    messages.find((m) => m.provider_sid === sid);

  const messagesRepo: MessagesRepo = {
    async append(message) {
      const tsMsgId = buildTsMsgId(message.providerTs, message.providerSid);
      // The SID-pointer conditional write: same provider SID never persists
      // twice, even when providerTs differs across redeliveries — and the
      // dedupe result carries the PERSISTED (first write's) tsMsgId.
      const existing = findBySid(message.providerSid);
      if (existing) return { deduped: true, tsMsgId: existing.tsMsgId };
      messages.push({
        conversationId: message.conversationId,
        tsMsgId,
        type: message.type,
        direction: message.direction,
        author: message.author,
        ...(message.body !== undefined && { body: message.body }),
        ...(message.mediaUrls !== undefined && { mediaUrls: message.mediaUrls }),
        provider_sid: message.providerSid,
        provider_ts: message.providerTs,
        delivery_status: message.deliveryStatus,
        ...(message.errorCode !== undefined && { error_code: message.errorCode }),
        created_at: new Date().toISOString(),
        // Relay group (M1.7): preserve the inbound relay annotations.
        ...(message.relaySenderKey !== undefined && { relay_sender_key: message.relaySenderKey }),
        ...(message.receivedOnClosedThread === true && { received_on_closed_thread: true }),
        // Relay group (M1.7): preserve the seeded per-recipient delivery map so
        // the fan-out's child-only setRecipientDelivery has a parent to write
        // into (mirrors the real repo's append passthrough).
        ...(message.deliveryRecipients !== undefined && {
          delivery_recipients: message.deliveryRecipients,
        }),
        // Share-broadcast (M1.8a): preserve the broadcast id stamp.
        ...(message.broadcastId !== undefined && { broadcast_id: message.broadcastId }),
        // Manual-retry lineage: preserve retry_of so the timeline serializer can
        // emit it (mirrors the real repo's append passthrough).
        ...(message.retryOf !== undefined && { retry_of: message.retryOf }),
        // Voice call (M1.9a): preserve the metadata-only call fields so tests
        // can assert masked/CallSid-idempotent/forward-only behavior.
        ...(message.callStatus !== undefined && { call_status: message.callStatus }),
        ...(message.callOutcome !== undefined && { call_outcome: message.callOutcome }),
        ...(message.startedAt !== undefined && { started_at: message.startedAt }),
        ...(message.answeredAt !== undefined && { answered_at: message.answeredAt }),
        ...(message.endedAt !== undefined && { ended_at: message.endedAt }),
        ...(message.callDuration !== undefined && { call_duration: message.callDuration }),
        ...(message.masked !== undefined && { masked: message.masked }),
        ...(message.callPartyLabel !== undefined && { call_party_label: message.callPartyLabel }),
        ...(message.recordingS3Key !== undefined && { recording_s3_key: message.recordingS3Key }),
        ...(message.transcript !== undefined && { transcript: message.transcript }),
      });
      return { deduped: false, tsMsgId };
    },
    async getByProviderSid(sid) {
      return findBySid(sid);
    },
    async updateDeliveryStatus(sid, status, errorCode) {
      const existing = findBySid(sid);
      if (!existing) return false;
      if (!allowedPriorStatuses(status).includes(existing.delivery_status)) return false;
      existing.delivery_status = status;
      if (errorCode !== undefined) existing.error_code = errorCode;
      return true;
    },
    async updateCallStatus(callSid, fields) {
      // Mirror the real repo: forward-only on call_status, idempotent stamp of
      // the supplied lifecycle fields. Unknown CallSid or a regressing
      // transition is a no-op (false) — so a redelivery never double-writes.
      const existing = findBySid(callSid);
      if (!existing) return false;
      const allowed = allowedPriorCallStatuses(fields.callStatus);
      const current = existing.call_status;
      if (current === undefined || !allowed.includes(current)) return false;
      existing.call_status = fields.callStatus;
      if (fields.callOutcome !== undefined) existing.call_outcome = fields.callOutcome;
      if (fields.answeredAt !== undefined) existing.answered_at = fields.answeredAt;
      if (fields.endedAt !== undefined) existing.ended_at = fields.endedAt;
      if (fields.callDuration !== undefined) existing.call_duration = fields.callDuration;
      return true;
    },
    async setCallRecording(callSid, recording) {
      // Mirror the real repo: idempotent per RecordingSid — once a recording is
      // stored (recording_sid present) a redelivery is a no-op (false).
      const existing = findBySid(callSid);
      if (!existing) return false;
      if (existing.recording_sid !== undefined) return false;
      existing.recording_s3_key = recording.recordingS3Key;
      existing.recording_sid = recording.recordingSid;
      if (recording.recordingDuration !== undefined) {
        existing.recording_duration = recording.recordingDuration;
      }
      return true;
    },
    async releaseCallRecording(callSid, recordingSid) {
      // Mirror the real repo (FIX 4): clear the claim ONLY when recording_sid
      // still equals the one we claimed (never clobber another writer).
      const existing = findBySid(callSid);
      if (!existing) return;
      if (existing.recording_sid !== recordingSid) return;
      delete existing.recording_sid;
      delete existing.recording_s3_key;
      delete existing.recording_duration;
    },
    async setCallTranscript(callSid, transcript) {
      // Mirror the real repo: idempotent — a non-empty transcript already
      // present is never overwritten (false).
      const existing = findBySid(callSid);
      if (!existing) return false;
      if (typeof existing.transcript === 'string' && existing.transcript.length > 0) return false;
      existing.transcript = transcript;
      return true;
    },
    async listByConversation(conversationId, opts = {}) {
      return messages
        .filter((m) => m.conversationId === conversationId)
        .filter((m) => (opts.before === undefined ? true : m.tsMsgId < opts.before))
        .sort((a, b) => (a.tsMsgId < b.tsMsgId ? 1 : -1))
        .slice(0, opts.limit ?? 50);
    },
    async annotateMessage(conversationId, tsMsgId, annotations) {
      const item = messages.find((m) => m.conversationId === conversationId && m.tsMsgId === tsMsgId);
      if (!item) throw new Error(`annotateMessage: no message ${conversationId}/${tsMsgId}`);
      if (annotations.mediaAttachments !== undefined) item.media_attachments = annotations.mediaAttachments;
      if (annotations.retryOf !== undefined) item.retry_of = annotations.retryOf;
      if (annotations.retryAttempt !== undefined) item.retry_attempt = annotations.retryAttempt;
    },
    async putJobExecutionMarker(jobId, conversationId) {
      // Mirrors the conditional put: true only on the FIRST write per jobId.
      if (jobExecutionMarkers.has(jobId)) return false;
      jobExecutionMarkers.set(jobId, conversationId);
      return true;
    },

    // --- Relay groups (M1.7) ---
    async setRecipientDelivery(conversationId, tsMsgId, memberKey, delivery) {
      const item = messages.find((m) => m.conversationId === conversationId && m.tsMsgId === tsMsgId);
      if (!item) throw new Error(`setRecipientDelivery: no message ${conversationId}/${tsMsgId}`);
      item.delivery_recipients = { ...(item.delivery_recipients ?? {}), [memberKey]: delivery };
    },
    async updateRecipientDeliveryStatus(conversationId, tsMsgId, memberKey, status, errorCode) {
      const item = messages.find((m) => m.conversationId === conversationId && m.tsMsgId === tsMsgId);
      const slot = item?.delivery_recipients?.[memberKey];
      if (!item || !slot) return false;
      if (!allowedPriorStatuses(status).includes(slot.status)) return false;
      const next = {
        ...slot,
        status,
        ...(errorCode !== undefined && { errorCode }),
        ...(status === 'delivered' && { deliveredAt: new Date().toISOString() }),
      };
      item.delivery_recipients = { ...item.delivery_recipients, [memberKey]: next };
      return true;
    },
    async putRelaySidPointer(providerSid, ref) {
      if (!relaySidPointers.has(providerSid)) relaySidPointers.set(providerSid, ref);
    },
    async getRelaySidPointer(providerSid) {
      return relaySidPointers.get(providerSid);
    },
  };

  // BE1/C1: the fake mirrors the real repo's phone invariants — phones[] seeded
  // from the scalar when absent, exactly-one-primary, and phone-pointer items
  // stored AS ENTRIES in the same `contacts` array (phone_ref/phone_ref_owner)
  // so the byPhone lookup resolves a non-primary number to its owner.
  const fakeSeededPhones = (contact: ContactItem): ContactPhone[] => {
    if (Array.isArray(contact.phones) && contact.phones.length > 0) {
      return contact.phones.map((p) => ({ ...p }));
    }
    if (typeof contact.phone === 'string' && contact.phone.length > 0) {
      return [
        {
          phone: contact.phone,
          primary: true,
          ...(typeof contact.created_at === 'string' && { firstSeenAt: contact.created_at }),
          lastSeenAt: new Date().toISOString(),
        },
      ];
    }
    return [];
  };
  const fakePutPointer = (phone: string, owner: string): void => {
    const id = phoneRefId(phone);
    if (contacts.some((c) => c.contactId === id)) return;
    // A pointer carries NO type/status (invisible to byTypeStatus) — but the
    // ContactItem type requires `type`, so use a non-listed sentinel. The real
    // item simply omits type; listByType filters by exact value either way.
    contacts.push({
      contactId: id,
      type: 'unknown',
      phone,
      phone_ref: true,
      phone_ref_owner: owner,
    } as ContactItem);
  };
  const fakeDeletePointer = (phone: string): void => {
    const id = phoneRefId(phone);
    const idx = contacts.findIndex((c) => c.contactId === id);
    if (idx >= 0) contacts.splice(idx, 1);
  };
  const fakeRequireContact = (contactId: string): ContactItem => {
    const contact = contacts.find((c) => c.contactId === contactId && c.phone_ref !== true);
    if (!contact) throw conditionalCheckFailed(`no contact ${contactId}`);
    return contact;
  };

  const contactsRepo: ContactsRepo = {
    async findByPhone(phone) {
      const hit = contacts.find((c) => c.phone === phone);
      if (!hit) return undefined;
      if (hit.phone_ref === true) {
        const owner = typeof hit.phone_ref_owner === 'string' ? hit.phone_ref_owner : undefined;
        if (owner === undefined) return undefined;
        return contacts.find((c) => c.contactId === owner);
      }
      return hit;
    },
    async getById(contactId) {
      return contacts.find((c) => c.contactId === contactId);
    },
    async listByType(type, opts = {}) {
      const items = contacts
        // BE1: pointer items carry no real type/status → invisible to this GSI.
        .filter((c) => c.phone_ref !== true)
        .filter((c) => c.type === type)
        .filter((c) => (opts.status === undefined ? true : c.status === opts.status))
        // Soft-delete: default excludes deleted; deleted:true shows ONLY deleted.
        .filter((c) => (opts.deleted === true ? isDeleted(c) : !isDeleted(c)))
        .slice(0, opts.limit ?? 50);
      return { items };
    },
    async listByHousingAuthority(housingAuthority, opts = {}) {
      // Mirror the byHousingAuthority GSI: tenant-sparse (only tenants carry the
      // attribute). The service defends the type invariant either way. BE1:
      // pointer items carry no housingAuthority → never indexed here.
      const items = contacts
        .filter((c) => c.phone_ref !== true)
        .filter((c) => c['housingAuthority'] === housingAuthority)
        // Broadcast targeting never reaches a soft-deleted contact.
        .filter((c) => !isDeleted(c))
        .slice(0, opts.limit ?? 50);
      return { items };
    },
    async create(input) {
      const now = new Date().toISOString();
      const item: ContactItem = {
        ...input,
        contactId: input.contactId ?? `contact-fake-${contacts.length + 1}`,
        type: input.type,
        created_at: input.created_at ?? now,
      };
      if (contacts.some((c) => c.contactId === item.contactId)) {
        throw conditionalCheckFailed(`create: contact ${item.contactId} exists`);
      }
      contacts.push({ ...item });
      contactCreates.push(item.contactId);
      return item;
    },
    async createIfAbsent(item) {
      if (contacts.some((c) => c.contactId === item.contactId)) return false;
      contacts.push({ ...item });
      contactCreates.push(item.contactId);
      return true;
    },
    async setFlag(contactId, flag) {
      const contact = contacts.find((c) => c.contactId === contactId);
      if (!contact) throw new Error(`setFlag: no contact ${contactId}`);
      contact[flag] = true;
      flagWrites.push({ contactId, flag, value: true });
    },
    async clearFlag(contactId, flag) {
      const contact = contacts.find((c) => c.contactId === contactId);
      if (!contact) throw new Error(`clearFlag: no contact ${contactId}`);
      contact[flag] = false;
      flagWrites.push({ contactId, flag, value: false });
    },
    async softDelete(contactId, at) {
      const contact = fakeRequireContact(contactId);
      contact.deleted_at = at;
      return contact;
    },
    async restore(contactId) {
      const contact = fakeRequireContact(contactId);
      delete contact.deleted_at;
      return contact;
    },
    async update(contactId, patch) {
      const contact = contacts.find((c) => c.contactId === contactId);
      if (!contact) {
        throw conditionalCheckFailed(`update: no contact ${contactId}`);
      }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (value === null) delete contact[key]; // null → REMOVE the attribute
        else contact[key] = value;
      }
      return contact;
    },

    // --- BE1/C1 multi-phone primitives (mirror the real repo's invariants) ---
    async addPhone(contactId, { phone, label }) {
      const contact = fakeRequireContact(contactId);
      const phones = fakeSeededPhones(contact);
      if (phones.some((p) => p.phone === phone)) {
        if (!Array.isArray(contact.phones)) contact.phones = phones;
        return contact;
      }
      const now = new Date().toISOString();
      contact.phones = [
        ...phones,
        {
          phone,
          primary: false,
          firstSeenAt: now,
          lastSeenAt: now,
          ...(label !== undefined && { label }),
        },
      ];
      fakePutPointer(phone, contactId);
      return contact;
    },
    async setPhone(contactId, phone, { primary, label }) {
      const contact = fakeRequireContact(contactId);
      const phones = fakeSeededPhones(contact);
      const target = phones.find((p) => p.phone === phone);
      if (!target) throw conditionalCheckFailed(`contact ${contactId} has no phone ${phone}`);
      if (label !== undefined) target.label = label;
      const oldPrimary = phones.find((p) => p.primary && p.phone !== phone);
      if (primary === true && !target.primary) {
        // Mirror the real repo's crash-safe promote ordering (BE1 FIX 4):
        // putPointer(old) FIRST (old still resolves), THEN swap scalar+phones[],
        // THEN deletePointer(new). Every number resolves to the owner throughout.
        if (oldPrimary) fakePutPointer(oldPrimary.phone, contactId);
        for (const p of phones) p.primary = p.phone === phone;
        contact.phone = phone; // scalar swap
        contact.phones = phones;
        fakeDeletePointer(phone);
        return contact;
      }
      contact.phones = phones;
      return contact;
    },
    async removePhone(contactId, phone) {
      const contact = fakeRequireContact(contactId);
      const phones = fakeSeededPhones(contact);
      const target = phones.find((p) => p.phone === phone);
      if (!target) throw conditionalCheckFailed(`contact ${contactId} has no phone ${phone}`);
      if (target.primary) throw new PrimaryPhoneRemovalError();
      contact.phones = phones.filter((p) => p.phone !== phone);
      fakeDeletePointer(phone);
      return contact;
    },
    async touchPhoneLastSeen(contactId, phone, at) {
      const contact = contacts.find((c) => c.contactId === contactId);
      if (!contact || !Array.isArray(contact.phones) || contact.phones.length === 0) return;
      const target = contact.phones.find((p) => p.phone === phone);
      if (!target) return;
      target.lastSeenAt = at;
    },
  };

  const auditRepo: AuditRepo = {
    async append(entityKey, eventType, payload) {
      // Mirror the REAL item shape (M2): `event_type`, plus a top-level
      // `actorId` lifted from payload.actor (the byActor GSI key, M1), so tests
      // exercise the actual attributes production writes — not a fake alias.
      const actor = payload?.['actor'];
      const actorId = typeof actor === 'string' ? actor : undefined;
      // Keep the recorded shape EXACTLY as the real repo's asserted item (no
      // extra keys — many tests do `toEqual` on world.auditEvents): entityKey,
      // event_type, optional actorId, optional payload. A monotonic `ts` is
      // attached on a non-enumerable key so listByEntity can order newest-first
      // without polluting the asserted object shape.
      const rec: FakeWorld['auditEvents'][number] = {
        entityKey,
        event_type: eventType,
        ...(actorId !== undefined && { actorId }),
        ...(payload !== undefined && { payload }),
      };
      Object.defineProperty(rec, '__seq', { value: auditEvents.length, enumerable: false });
      auditEvents.push(rec);
    },
    async listByEntity(entityKey, opts = {}) {
      // Mirror the real repo: NEWEST-FIRST. The fake uses insertion order (the
      // hidden __seq) as the clock; `before` is an exclusive __seq bound when a
      // test pages (none currently do). limit defaults to 50.
      const seqOf = (e: object): number =>
        typeof (e as { __seq?: number }).__seq === 'number' ? (e as { __seq: number }).__seq : 0;
      const beforeSeq = typeof opts.before === 'string' ? Number(opts.before) : undefined;
      const items = auditEvents
        .filter((e) => e.entityKey === entityKey)
        .filter((e) => (beforeSeq === undefined || Number.isNaN(beforeSeq) ? true : seqOf(e) < beforeSeq))
        .slice()
        .sort((a, b) => seqOf(b) - seqOf(a)) // newest-first
        .slice(0, opts.limit ?? 50)
        .map((e) => ({ ...e }));
      return items as import('../../src/repos/auditRepo.js').AuditEvent[];
    },
  };

  // In-memory org settings (M1.4): starts at the CO2 defaults; putOrgSettings
  // merges a partial patch (field-level) exactly like the real repo.
  const settings: OrgSettings = { ...DEFAULT_ORG_SETTINGS };
  const settingsRepo: SettingsRepo = {
    async getOrgSettings() {
      return { ...settings };
    },
    async putOrgSettings(patch) {
      if (patch.missedCallAutoText !== undefined) settings.missedCallAutoText = patch.missedCallAutoText;
      if (patch.missedCallAutoTextEnabled !== undefined)
        settings.missedCallAutoTextEnabled = patch.missedCallAutoTextEnabled;
      if (patch.quickReplies !== undefined) settings.quickReplies = patch.quickReplies;
      if (patch.preRingPauseSeconds !== undefined) settings.preRingPauseSeconds = patch.preRingPauseSeconds;
      if (patch.welcomeText === null) {
        // Explicit CLEAR — delete the attribute (mirrors the real repo's REMOVE),
        // so getOrgSettings projects no welcomeText and public.ts falls back.
        delete settings.welcomeText;
      } else if (patch.welcomeText !== undefined) {
        settings.welcomeText = patch.welcomeText;
      }
      return { ...settings };
    },
  };

  // Fake vocabulary repo (Task 4): accumulates tokens in three in-memory Sets;
  // add() records each call onto vocabularyAdds for test assertions.
  const vocabularyAdds: FakeWorld['vocabularyAdds'] = [];
  const vocabSets: Record<'roles' | 'relationshipRoles' | 'fieldLabels', Set<string>> = {
    roles: new Set(),
    relationshipRoles: new Set(),
    fieldLabels: new Set(),
  };
  const vocabularyRepo: ContactVocabularyRepo = {
    async add(tokens) {
      vocabularyAdds.push(tokens);
      for (const group of ['roles', 'relationshipRoles', 'fieldLabels'] as const) {
        const arr = tokens[group];
        if (Array.isArray(arr)) {
          for (const t of arr) if (typeof t === 'string' && t.length > 0) vocabSets[group].add(t);
        }
      }
    },
    async get(): Promise<ContactVocabulary> {
      return {
        roles: [...vocabSets.roles].sort(),
        relationshipRoles: [...vocabSets.relationshipRoles].sort(),
        fieldLabels: [...vocabSets.fieldLabels].sort(),
      };
    },
  };

  // Fake push service (M1.9b): records every sendToUser so tests can assert the
  // pre-ring / missed-call pushes (kind + payload — and that NO raw phone leaks
  // into them). Returns a "configured, 1 sent" tally; never touches the network.
  const pushSends: FakeWorld['pushSends'] = [];
  const pushService: PushService = {
    async sendToUser(userId: string, notification: PushNotification): Promise<SendToUserResult> {
      pushSends.push({ userId, notification });
      return { configured: true, attempted: 1, sent: 1, pruned: 0, failed: 0 };
    },
  };

  // In-memory units (M1.5): mirror the repo's contractual semantics —
  // generate-id create, SET-merge update (no-overwrite of unset fields),
  // conditional 404 on update, GSI-shaped list queries.
  const units = new Map<string, UnitItem>();
  let unitCounter = 0;
  const unitsRepo: UnitsRepo = {
    async create(input) {
      const now = new Date().toISOString();
      const item: UnitItem = {
        ...input,
        unitId: input.unitId ?? `unit-${++unitCounter}`,
        created_at: typeof input.created_at === 'string' ? input.created_at : now,
        updated_at: now,
      };
      units.set(item.unitId, item);
      return item;
    },
    async getById(unitId) {
      return units.get(unitId);
    },
    async update(unitId, patch) {
      const unit = units.get(unitId);
      if (!unit) throw conditionalCheckFailed(`update: no unit ${unitId}`);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue; // omitted → untouched
        if (value === null) {
          delete unit[key]; // null → REMOVE (mirror the real repo)
        } else {
          unit[key] = value;
        }
      }
      unit.updated_at = new Date().toISOString();
      return unit;
    },
    // Soft-delete: default excludes deleted; deleted:true shows ONLY deleted.
    async softDelete(unitId, at) {
      const unit = units.get(unitId);
      if (!unit) throw conditionalCheckFailed(`softDelete: no unit ${unitId}`);
      unit.deleted_at = at;
      unit.updated_at = at;
      return unit;
    },
    async restore(unitId) {
      const unit = units.get(unitId);
      if (!unit) throw conditionalCheckFailed(`restore: no unit ${unitId}`);
      delete unit.deleted_at;
      unit.updated_at = new Date().toISOString();
      return unit;
    },
    async listByLandlord(landlordId, opts = {}) {
      const items = [...units.values()]
        .filter((u) => u.landlordId === landlordId)
        .filter((u) => (opts.deleted === true ? isUnitDeleted(u) : !isUnitDeleted(u)))
        .slice(0, opts.limit ?? 50);
      return { items };
    },
    async listByStatus(status, opts = {}) {
      // Honor the same paging contract as the real repo (BE5/C6 parity): resume
      // after the cursor's unitId, return at most `limit` items, and emit a
      // lastEvaluatedKey only when more remain. When NO limit is passed, return
      // ALL matching units (never a hidden default cap that drops candidates).
      const all = [...units.values()]
        .filter((u) => u.status === status)
        .filter((u) => (opts.deleted === true ? isUnitDeleted(u) : !isUnitDeleted(u)));
      let start = 0;
      const cursorId = opts.exclusiveStartKey?.['unitId'];
      if (typeof cursorId === 'string') {
        const idx = all.findIndex((u) => u.unitId === cursorId);
        if (idx >= 0) start = idx + 1;
      }
      const window =
        opts.limit === undefined ? all.slice(start) : all.slice(start, start + opts.limit);
      const items = window.map((u) => ({ ...u }));
      const last = window[window.length - 1];
      const hasMore = opts.limit !== undefined && start + opts.limit < all.length;
      return {
        items,
        ...(hasMore &&
          last !== undefined && {
            lastEvaluatedKey: { unitId: last.unitId } as Record<string, unknown>,
          }),
      };
    },
    async listByJurisdiction(jurisdiction, opts = {}) {
      const items = [...units.values()]
        .filter((u) => u.jurisdiction === jurisdiction)
        .filter((u) => (opts.deleted === true ? isUnitDeleted(u) : !isUnitDeleted(u)))
        .slice(0, opts.limit ?? 50);
      return { items };
    },
    async listByProperty(propertyId, opts = {}) {
      // Mirror the sparse byProperty GSI: only units carrying propertyId index.
      const items = [...units.values()]
        .filter((u) => typeof u.propertyId === 'string' && u.propertyId === propertyId)
        .filter((u) => (opts.deleted === true ? isUnitDeleted(u) : !isUnitDeleted(u)))
        .slice(0, opts.limit ?? 50);
      return { items };
    },
    async addContact(unitId, contact) {
      // Mirror the real repo's invariants: seed from landlordId, upsert by
      // contactId, exactly-one-primaryVoice, and keep primary_voice_contact
      // consistent with the roster's ☎ primary.
      const unit = units.get(unitId);
      if (!unit) throw conditionalCheckFailed(`addContact: no unit ${unitId}`);
      const roster = unitContacts(unit).map((c) => ({ ...c }));
      const existing = roster.find((c) => c.contactId === contact.contactId);
      const primaryVoice = contact.primaryVoice === true;
      // FIX C: the owning landlord's role is structural — pinned to 'landlord'.
      const isPrimaryLandlord =
        typeof unit.landlordId === 'string' && contact.contactId === unit.landlordId;
      const role: UnitContact['role'] = isPrimaryLandlord ? 'landlord' : contact.role;
      if (existing) {
        existing.role = role;
        existing.primaryVoice = primaryVoice;
        if (contact.name !== undefined) existing.name = contact.name;
        if (contact.company !== undefined) existing.company = contact.company;
      } else {
        const entry: UnitContact = {
          contactId: contact.contactId,
          role,
          primaryVoice,
          ...(contact.name !== undefined ? { name: contact.name } : {}),
          ...(contact.company !== undefined ? { company: contact.company } : {}),
        };
        roster.push(entry);
      }
      if (primaryVoice) {
        for (const c of roster) c.primaryVoice = c.contactId === contact.contactId;
      }
      unit.contacts = roster;
      const primary = roster.find((c) => c.primaryVoice);
      if (primary !== undefined) unit.primary_voice_contact = primary.contactId;
      unit.updated_at = new Date().toISOString();
      return unit;
    },
    async removeContact(unitId, contactId) {
      const unit = units.get(unitId);
      if (!unit) throw conditionalCheckFailed(`removeContact: no unit ${unitId}`);
      if (typeof unit.landlordId === 'string' && unit.landlordId === contactId) {
        throw new CannotRemovePrimaryLandlordError();
      }
      const roster = unitContacts(unit).map((c) => ({ ...c }));
      const target = roster.find((c) => c.contactId === contactId);
      if (!target) throw conditionalCheckFailed(`removeContact: unit ${unitId} has no contact ${contactId}`);
      const removedWasPrimaryVoice = target.primaryVoice;
      const next = roster.filter((c) => c.contactId !== contactId);
      unit.contacts = next;
      // FIX B: keep the roster primaryVoice flag and the primary_voice_contact
      // scalar in agreement after removing the ☎ primary (lockstep with the real
      // repo).
      if (removedWasPrimaryVoice) {
        const landlordId = typeof unit.landlordId === 'string' ? unit.landlordId : '';
        if (landlordId.length > 0) {
          for (const c of next) c.primaryVoice = c.contactId === landlordId;
          unit.primary_voice_contact = landlordId;
        } else {
          for (const c of next) c.primaryVoice = false;
          delete unit.primary_voice_contact; // null → REMOVE; never dangling
        }
      }
      unit.updated_at = new Date().toISOString();
      return unit;
    },
    async list(opts = {}) {
      const items = [...units.values()]
        .filter((u) => (opts.deleted === true ? isUnitDeleted(u) : !isUnitDeleted(u)))
        .slice(0, opts.limit ?? 50);
      return { items };
    },
  };

  // In-memory placements (M1.10): mirror the repo's contractual semantics —
  // generate-id create, SET-merge update with null→REMOVE + the next_deadline
  // composite-key REFUSAL, both-or-neither setNextDeadline, conditional 404, and
  // the GSI-shaped list queries. (Cursor pagination is integration-tested in
  // placementsRepo.integration.test.ts; this fake slices by limit only.)
  const placements = new Map<string, PlacementItem>();
  let placementCounter = 0;
  // Mirror the byTenant/byUnit GSI's keyset pagination (parity with the real
  // repo, BE-foundation): resume after the cursor's placementId, take `limit`, and
  // emit a lastEvaluatedKey ONLY when a limit was passed AND more items remain.
  // With NO limit the whole result returns in one page (no lastEvaluatedKey) —
  // so existing single-page callers are unaffected. The sibling-placement scan
  // passes a limit to force ≥2 pages and exercise the follow-the-cursor loop.
  const placementPage = (
    all: PlacementItem[],
    opts: { limit?: number; exclusiveStartKey?: Record<string, unknown> },
  ): { items: PlacementItem[]; lastEvaluatedKey?: Record<string, unknown> } => {
    let start = 0;
    const cursorId = opts.exclusiveStartKey?.['placementId'];
    if (typeof cursorId === 'string') {
      const idx = all.findIndex((c) => c.placementId === cursorId);
      if (idx >= 0) start = idx + 1;
    }
    const window = opts.limit === undefined ? all.slice(start) : all.slice(start, start + opts.limit);
    const items = window.map((c) => ({ ...c }));
    const last = window[window.length - 1];
    const hasMore = opts.limit !== undefined && start + opts.limit < all.length;
    return {
      items,
      ...(hasMore &&
        last !== undefined && {
          lastEvaluatedKey: { placementId: last.placementId } as Record<string, unknown>,
        }),
    };
  };
  const placementsRepo: PlacementsRepo = {
    async create(input) {
      const now = new Date().toISOString();
      const item: PlacementItem = {
        ...input,
        placementId: input.placementId ?? `placement-${++placementCounter}`,
        created_at: typeof input.created_at === 'string' ? input.created_at : now,
        updated_at: now,
      };
      placements.set(item.placementId, item);
      return { ...item };
    },
    async getById(placementId) {
      const c = placements.get(placementId);
      return c ? { ...c } : undefined;
    },
    async update(placementId, patch) {
      const c = placements.get(placementId);
      if (!c) throw conditionalCheckFailed(`update: no placement ${placementId}`);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (key === 'next_deadline_type' || key === 'next_deadline_at') {
          throw new Error('placementsRepo.update: set next_deadline via setNextDeadline');
        }
        if (value === null) delete c[key];
        else c[key] = value;
      }
      c.updated_at = new Date().toISOString();
      return { ...c };
    },
    async setNextDeadline(placementId, deadline: PlacementDeadline | null) {
      const c = placements.get(placementId);
      if (!c) throw conditionalCheckFailed(`setNextDeadline: no placement ${placementId}`);
      if (deadline === null) {
        delete c.next_deadline_type;
        delete c.next_deadline_at;
      } else {
        c.next_deadline_type = deadline.type;
        c.next_deadline_at = deadline.at;
      }
      c.updated_at = new Date().toISOString();
      return { ...c };
    },
    async listByTenant(tenantId, opts = {}) {
      const all = [...placements.values()].filter((c) => c.tenantId === tenantId);
      return placementPage(all, opts);
    },
    async listByUnit(unitId, opts = {}) {
      const all = [...placements.values()].filter((c) => c.unitId === unitId);
      return placementPage(all, opts);
    },
    async listByStage(stage, opts = {}) {
      const items = [...placements.values()].filter((c) => c.stage === stage).slice(0, opts.limit ?? 50);
      return { items: items.map((c) => ({ ...c })) };
    },
    async listByTourDate(tourDate, opts = {}) {
      const items = [...placements.values()].filter((c) => c.tour_date === tourDate).slice(0, opts.limit ?? 50);
      return { items: items.map((c) => ({ ...c })) };
    },
    async listByNextDeadline(type, opts = {}) {
      const items = [...placements.values()]
        // Composite SPARSE key: a row exists in byNextDeadline only when BOTH
        // attrs are present — mirror the real GSI (never a half-set), so the fake
        // can't admit a state production can't represent.
        .filter((c) => c.next_deadline_type === type && typeof c.next_deadline_at === 'string')
        .filter((c) =>
          opts.beforeAt === undefined ? true : (c.next_deadline_at as string) <= opts.beforeAt,
        )
        .sort((a, b) => {
          const cmp = (a.next_deadline_at as string) < (b.next_deadline_at as string) ? -1 : 1;
          return (opts.scanIndexForward ?? true) ? cmp : -cmp;
        })
        .slice(0, opts.limit ?? 50);
      return { items: items.map((c) => ({ ...c })) };
    },
    async list(opts = {}) {
      const items = [...placements.values()].slice(0, opts.limit ?? 50);
      return { items: items.map((c) => ({ ...c })) };
    },
  };

  // In-memory activity events (BE2/C2): mirror the repo's semantics — a Put with
  // a fresh `<at>#<eventId>` SK (so no append is ever a redelivery), and a
  // listByContact that returns newest-first with an exclusive `before` bound +
  // limit (the merged-timeline endpoint reads through this).
  const activityEvents: ActivityEventItem[] = [];
  let activityEventCounter = 0;
  const activityEventsRepo: ActivityEventsRepo = {
    async record(input) {
      const at = input.at ?? new Date().toISOString();
      const eventId = `evt-fake-${++activityEventCounter}`;
      const item: ActivityEventItem = {
        contactId: input.contactId,
        tsEventId: buildTsEventId(at, eventId),
        eventId,
        at,
        type: input.type,
        label: input.label,
        created_at: new Date().toISOString(),
        ...(input.refType !== undefined && { refType: input.refType }),
        ...(input.refId !== undefined && { refId: input.refId }),
      };
      activityEvents.push(item);
      return { ...item };
    },
    async listByContact(contactId, opts = {}) {
      const items = activityEvents
        .filter((e) => e.contactId === contactId)
        .filter((e) => (opts.before === undefined ? true : e.tsEventId < opts.before))
        .sort((a, b) => (a.tsEventId < b.tsEventId ? 1 : -1)) // newest-first
        .slice(0, opts.limit ?? 50)
        .map((e) => ({ ...e }));
      return { items };
    },
  };

  // In-memory listing sends (BE4/C4): mirror the repo's contractual semantics —
  // an UPSERT keyed by (unitId, contactId) that seeds response='no_reply' on the
  // FIRST send and NEVER resets it on a re-send (only refreshes sentAt/via/
  // broadcastId), setResponse conditional on the row existing (404-shaped throw
  // when absent), listByUnit (base table) + listByContact (newest-first by
  // sentAt, the byContact GSI direction).
  const listingSends: ListingSendItem[] = [];
  const findListingSend = (unitId: string, contactId: string): ListingSendItem | undefined =>
    listingSends.find((r) => r.unitId === unitId && r.contactId === contactId);
  const listingSendsRepo: ListingSendsRepo = {
    async recordSend(input) {
      const now = new Date().toISOString();
      const sentAt = input.sentAt ?? now;
      const existing = findListingSend(input.unitId, input.contactId);
      if (existing) {
        // RE-SEND: refresh sentAt/via/broadcastId + updated_at; NEVER reset
        // response. An individual re-send with no broadcastId clears the prior
        // attribution (mirrors the real repo's REMOVE).
        existing.sentAt = sentAt;
        existing.via = input.via;
        existing.updated_at = now;
        if (input.broadcastId !== undefined) existing.broadcastId = input.broadcastId;
        else delete existing.broadcastId;
        return { ...existing };
      }
      const item: ListingSendItem = {
        unitId: input.unitId,
        contactId: input.contactId,
        response: 'no_reply',
        sentAt,
        via: input.via,
        created_at: now,
        updated_at: now,
        ...(input.broadcastId !== undefined && { broadcastId: input.broadcastId }),
      };
      listingSends.push(item);
      return { ...item };
    },
    async getByKey(unitId, contactId) {
      const existing = findListingSend(unitId, contactId);
      return existing ? { ...existing } : undefined;
    },
    async setResponse(unitId, contactId, response) {
      // Mirror the real repo's atomic conditional: not-found throws; an
      // unchanged value is a no-op (changed:false, NO milestone); a real
      // transition writes and returns changed:true.
      const existing = findListingSend(unitId, contactId);
      if (!existing) {
        throw new ListingSendNotFoundError(unitId, contactId);
      }
      if (existing.response === response) {
        return { row: { ...existing }, changed: false };
      }
      existing.response = response;
      existing.updated_at = new Date().toISOString();
      return { row: { ...existing }, changed: true };
    },
    async listByUnit(unitId) {
      return listingSends.filter((r) => r.unitId === unitId).map((r) => ({ ...r }));
    },
    async listByContact(contactId) {
      return listingSends
        .filter((r) => r.contactId === contactId)
        .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1)) // newest-first by sentAt
        .map((r) => ({ ...r }));
    },
  };

  // In-memory broadcasts (M1.8a): mirror the repo's contractual semantics —
  // generate-id create, markSending draft-gate + recipients seed, setRecipient
  // map slot, atomic bumpStats, terminal markSent/markFailed.
  const broadcasts = new Map<string, BroadcastItem>();
  let broadcastCounter = 0;
  /**
   * Mirror the repo's GSI pagination over an already-ordered list: resume after
   * the cursor's broadcastId (keyset), take `limit`, and emit a lastEvaluatedKey
   * (the GSI ExclusiveStartKey shape) only when more items remain.
   */
  const pageBroadcasts = (
    ordered: BroadcastItem[],
    opts: { limit?: number; exclusiveStartKey?: Record<string, unknown> },
  ): { items: BroadcastItem[]; lastEvaluatedKey?: Record<string, unknown> } => {
    let start = 0;
    const cursorId = opts.exclusiveStartKey?.['broadcastId'];
    if (typeof cursorId === 'string') {
      const idx = ordered.findIndex((b) => b.broadcastId === cursorId);
      if (idx >= 0) start = idx + 1;
    }
    const limit = opts.limit ?? 50;
    const window = ordered.slice(start, start + limit);
    const items = window.map((b) => ({ ...b }));
    const hasMore = start + limit < ordered.length;
    const last = window[window.length - 1];
    return {
      items,
      // The GSI ExclusiveStartKey (byCreatedAt): base key + GSI keys — a small
      // flat scalar object the route's decodeCursor accepts (1..3 string attrs).
      ...(hasMore && last !== undefined && {
        lastEvaluatedKey: {
          broadcastId: last.broadcastId,
          created_by: last.created_by,
          created_at: last.created_at,
        } as Record<string, unknown>,
      }),
    };
  };
  const broadcastsRepo: BroadcastsRepo = {
    async create(input) {
      const now = new Date().toISOString();
      const stats: BroadcastStats = zeroStats();
      if (typeof input.estimatedAudience === 'number') stats.audience = input.estimatedAudience;
      const item: BroadcastItem = {
        broadcastId: input.broadcastId ?? `bcast-${++broadcastCounter}`,
        created_by: input.created_by,
        created_at: now,
        status: 'draft',
        audience_filter: input.audience_filter,
        body_template: input.body_template,
        stats,
        recipients: {},
        updated_at: now,
        ...(input.unitId !== undefined && { unitId: input.unitId }),
        ...(input.flyer_url !== undefined && { flyer_url: input.flyer_url }),
      };
      broadcasts.set(item.broadcastId, item);
      return { ...item };
    },
    async getById(broadcastId) {
      const b = broadcasts.get(broadcastId);
      return b ? { ...b } : undefined;
    },
    async listByStatus(status, opts = {}) {
      const all = [...broadcasts.values()].filter((b) => b.status === status);
      return pageBroadcasts(all, opts);
    },
    async listByCreatedBy(createdBy, opts = {}) {
      const all = [...broadcasts.values()]
        .filter((b) => b.created_by === createdBy)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return pageBroadcasts(all, opts);
    },
    async markSending(broadcastId, recipients) {
      const b = broadcasts.get(broadcastId);
      if (!b) throw conditionalCheckFailed(`markSending: no broadcast ${broadcastId}`);
      if (b.status !== 'draft') {
        throw conditionalCheckFailed(`markSending: broadcast ${broadcastId} is not a draft`);
      }
      b.status = 'sending';
      b.recipients = recipients;
      b.stats.audience = Object.keys(recipients).length;
      b.stats.queued = Object.keys(recipients).length;
      b.updated_at = new Date().toISOString();
      return { ...b };
    },
    async setRecipient(broadcastId, contactKey, recipient, allowedPriorStatuses) {
      const b = broadcasts.get(broadcastId);
      if (!b) throw conditionalCheckFailed(`setRecipient: no broadcast ${broadcastId}`);
      if (allowedPriorStatuses !== undefined) {
        // Mirror the real conditional write: only apply when the slot's current
        // nested status is an allowed predecessor. The loser of a concurrent
        // transition returns false (no stat double-bump) — never throws.
        const current = b.recipients[contactKey]?.status;
        if (current === undefined || !allowedPriorStatuses.includes(current)) {
          return false;
        }
      }
      b.recipients = { ...b.recipients, [contactKey]: recipient };
      return true;
    },
    async bumpStats(broadcastId, delta) {
      const b = broadcasts.get(broadcastId);
      if (!b) throw conditionalCheckFailed(`bumpStats: no broadcast ${broadcastId}`);
      for (const [key, value] of Object.entries(delta)) {
        if (typeof value === 'number') {
          (b.stats as unknown as Record<string, number>)[key] =
            ((b.stats as unknown as Record<string, number>)[key] ?? 0) + value;
        }
      }
      b.updated_at = new Date().toISOString();
      return { ...b };
    },
    async markSent(broadcastId) {
      const b = broadcasts.get(broadcastId);
      if (!b) throw conditionalCheckFailed(`markSent: no broadcast ${broadcastId}`);
      b.status = 'sent';
      b.updated_at = new Date().toISOString();
      return { ...b };
    },
    async markFailed(broadcastId, lastError) {
      const b = broadcasts.get(broadcastId);
      if (!b) throw conditionalCheckFailed(`markFailed: no broadcast ${broadcastId}`);
      b.status = 'failed';
      if (lastError !== undefined) b.last_error = lastError;
      b.updated_at = new Date().toISOString();
      return { ...b };
    },
    async listByUnit(unitId, opts = {}) {
      // Sparse byUnit GSI: only broadcasts WITH a unitId index.
      const all = [...broadcasts.values()].filter((b) => b.unitId === unitId);
      return pageBroadcasts(all, opts);
    },
    async priorRecipientContactIds(unitId) {
      // Union of every sent/sending broadcast's recipients KEYS for the unit.
      const prior = new Set<string>();
      for (const b of broadcasts.values()) {
        if (b.unitId !== unitId) continue;
        if (b.status !== 'sent' && b.status !== 'sending') continue;
        for (const key of Object.keys(b.recipients ?? {})) prior.add(key);
      }
      return prior;
    },
    async delete(broadcastId) {
      // Conditional delete — only a draft. Mirror the real repo's discriminated
      // result (the route maps it to 200 / 404 / 409).
      const b = broadcasts.get(broadcastId);
      if (!b) return { deleted: false, reason: 'not_found' };
      if (b.status !== 'draft') return { deleted: false, reason: 'not_draft' };
      broadcasts.delete(broadcastId);
      return { deleted: true };
    },
  };

  // In-memory tours (Tours feature): mirror the repo's contractual semantics —
  // generate-id create, get, listByTenant/listByUnit/listByScheduledRange GSI
  // queries, and SET-merge patch with conditional-check on existence.
  const toursMap = new Map<string, TourItem>();
  let tourCounter = 0;
  const toursRepo: ToursRepo = {
    async create(input) {
      const now = new Date().toISOString();
      const item: TourItem = {
        ...input,
        tourId: input.tourId ?? `tour-${++tourCounter}`,
        _schedPartition: 'tours',
        status: input.status ?? 'scheduled',
        createdAt: typeof input.createdAt === 'string' ? input.createdAt : now,
        updatedAt: now,
      };
      if (toursMap.has(item.tourId)) {
        throw new TourConditionalCheckFailedException({ message: `create: tour ${item.tourId} exists`, $metadata: {} });
      }
      toursMap.set(item.tourId, { ...item });
      return { ...item };
    },
    async get(tourId) {
      const t = toursMap.get(tourId);
      return t ? { ...t } : undefined;
    },
    async listByTenant(tenantId) {
      return [...toursMap.values()].filter((t) => t.tenantId === tenantId).map((t) => ({ ...t }));
    },
    async listByUnit(unitId) {
      return [...toursMap.values()].filter((t) => t.unitId === unitId).map((t) => ({ ...t }));
    },
    async listByScheduledRange(from, to) {
      // Sparse byScheduledAt GSI mirror: items without scheduledAt are never indexed.
      return [...toursMap.values()]
        .filter((t) => t.scheduledAt !== undefined && t.scheduledAt >= from && t.scheduledAt <= to)
        .map((t) => ({ ...t }));
    },
    async patch(tourId, updates) {
      const t = toursMap.get(tourId);
      if (!t) {
        throw new TourConditionalCheckFailedException({ message: `patch: no tour ${tourId}`, $metadata: {} });
      }
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) continue;
        if (value === null) delete t[key];
        else t[key] = value;
      }
      t.updatedAt = new Date().toISOString();
      toursMap.set(tourId, t);
      return { ...t };
    },
  };

  const tourRemindersMap = new Map<string, TourReminderItem>();
  let reminderCounter = 0;
  const tourRemindersRepo: TourRemindersRepo = {
    async create(input) {
      const now = new Date().toISOString();
      const item: TourReminderItem = {
        reminderId: `reminder-${++reminderCounter}`,
        tourId: input.tourId,
        kind: input.kind,
        dueAt: input.dueAt,
        _reminderPartition: 'reminders',
        createdAt: now,
      };
      tourRemindersMap.set(item.reminderId, { ...item });
      return { ...item };
    },
    async listByTour(tourId) {
      return [...tourRemindersMap.values()]
        .filter((r) => r.tourId === tourId)
        .map((r) => ({ ...r }));
    },
    async listDue(now) {
      return [...tourRemindersMap.values()]
        .filter((r) => r.dueAt <= now && r.sentAt === undefined && r.canceledAt === undefined)
        .map((r) => ({ ...r }));
    },
    async claimSend(reminderId, claimedAt) {
      const r = tourRemindersMap.get(reminderId);
      if (!r || r.sentAt !== undefined || r.canceledAt !== undefined) {
        return false;
      }
      r.sentAt = claimedAt;
      tourRemindersMap.set(reminderId, r);
      return true;
    },
    async cancelForTour(tourId) {
      const now = new Date().toISOString();
      for (const r of tourRemindersMap.values()) {
        if (r.tourId === tourId && r.sentAt === undefined && r.canceledAt === undefined) {
          r.canceledAt = now;
          tourRemindersMap.set(r.reminderId, r);
        }
      }
    },
  };

  const adapter: MessagingAdapter = {
    async sendMessage(params): Promise<SendMessageResult> {
      sent.push(params);
      return {
        providerSid: `SMfake-out-${++sidCounter}`,
        status: 'queued',
        providerTs: new Date().toISOString(),
      };
    },
    async getMediaStream(mediaUrl) {
      if (failMediaUrls.has(mediaUrl)) throw new Error(`fake media fetch failed: 404`);
      return Readable.from([Buffer.from(`media-bytes-for:${mediaUrl}`)]);
    },
    async getRecordingStream(recordingUrl) {
      // M1.9c: simulate the authed recording-media fetch. A URL in
      // failRecordingUrls throws (the fetch-failure path); otherwise stream
      // deterministic fake audio bytes for the recording round-trip assertions.
      if (failRecordingUrls.has(recordingUrl)) throw new Error(`fake recording fetch failed: 404`);
      return Readable.from([Buffer.from(`recording-bytes-for:${recordingUrl}`)]);
    },
    async provisionPhoneNumber() {
      const seq = String(++provisionCounter).padStart(4, '0');
      return {
        phoneNumber: `+1555010${seq}`,
        capabilities: { sms: true, voice: true },
        sid: `PNfake-${seq}`,
      };
    },
    async setVoiceWebhook() {
      // no-op fake
    },
    async initiateCall(params) {
      // Voice (M1.9a): record the origination + return a deterministic fake
      // CallSid. The inbound masked bridge answers with TwiML (no initiateCall),
      // so this only fires for press-0/founder-bridge seams.
      initiatedCalls.push(params);
      return { callSid: `CAfake-${++callCounter}` };
    },
  };

  const mediaStore: MediaStore = {
    async put(key, body, contentType) {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        const buf = chunk as Buffer;
        bytes += buf.length;
        chunks.push(buf);
      }
      mediaPuts.push({ key, ...(contentType !== undefined && { contentType }), bytes });
      // Keep the bytes so getStream can read back what put stored (the M1.9c
      // recording round-trip: callback stores → serving endpoint streams).
      mediaObjects.set(key, {
        body: Buffer.concat(chunks),
        ...(contentType !== undefined && { contentType }),
      });
    },
    async getStream(key) {
      const obj = mediaObjects.get(key);
      if (!obj) return undefined;
      return {
        body: Readable.from([obj.body]),
        ...(obj.contentType !== undefined && { contentType: obj.contentType }),
        contentLength: obj.body.length,
      };
    },
  };

  return {
    conversations,
    messages,
    jobExecutionMarkers,
    relaySidPointers,
    contacts,
    flagWrites,
    optOutSets,
    auditEvents,
    touches,
    contactCreates,
    unreadIncrements,
    sent,
    initiatedCalls,
    mediaPuts,
    failMediaUrls,
    failRecordingUrls,
    mediaObjects,
    events,
    emitted,
    conversationsRepo,
    messagesRepo,
    contactsRepo,
    auditRepo,
    units,
    unitsRepo,
    placements,
    placementsRepo,
    activityEvents,
    activityEventsRepo,
    listingSends,
    listingSendsRepo,
    broadcasts,
    broadcastsRepo,
    settings,
    settingsRepo,
    vocabularyAdds,
    vocabularyRepo,
    pushSends,
    pushService,
    adapter,
    mediaStore,
    toursMap,
    toursRepo,
    tourRemindersMap,
    tourRemindersRepo,
  };
}

// ---------------------------------------------------------------------------
// App builder + signed POST helper
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** Env overrides merged into the default test env (set a key to '' to unset… use delete semantics below). */
  env?: Record<string, string | undefined>;
  world?: FakeWorld;
  /** Omit the media store (simulates MEDIA_BUCKET unset). */
  withoutMediaStore?: boolean;
  /** Unknown-SID retry window for /status (tests shrink the default 2500ms). */
  statusUnknownSidRetryDelayMs?: number;
  /** SSE heartbeat override for /api/events tests (default 25s). */
  sseHeartbeatMs?: number;
  /** Injected pool-numbers service for the M1.7 relay API tests. */
  poolNumbersService?: PoolNumbersService;
  /**
   * Override the share-broadcast audience resolver (M1.8a). Default resolves
   * against the world contacts; tests inject a stub to drive the over-cap /
   * truncated refusal paths without seeding thousands of contacts.
   */
  audienceResolutionService?: AudienceResolutionService;
  /**
   * Inject a fake System Status service (M1.4; no AWS). Default: the route's
   * real config-driven service, which degrades to { available: false } on the
   * hermetic stack (console driver). Tests inject a stub to drive the
   * available:true alarms/errors route shape.
   */
  systemStatusService?: SystemStatusService;
  /**
   * Injected clock for tour-reminder arm/re-arm dueAt computation (tests that
   * assert exact dueAt values). Omit to use the wall clock.
   */
  toursNow?: () => string;
}

export interface Harness {
  app: Express;
  world: FakeWorld;
  capture: LogCapture;
  config: AppConfig;
  /** Fake users repo seeded with TEST_SESSION_USER (the epoch check reads it). */
  fakeUsers: FakeUsersRepo;
}

export function makeWebhookHarness(opts: HarnessOptions = {}): Harness {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    CF_ORIGIN_SECRET: ORIGIN_SECRET,
    MESSAGING_DRIVER: 'console',
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    PUBLIC_BASE_URL: PUBLIC_BASE_URL,
    OUR_PHONE_NUMBERS: OUR_NUMBER,
    // M1.3 auth wiring — production fail-fast keys, so tests overriding
    // NODE_ENV to 'production' still boot. SESSION_SECRET deliberately
    // matches the dev placeholder: the sealed cookies minted by
    // helpers/authSession.ts stay valid against harness-built apps.
    SESSION_SECRET: DEV_SESSION_SECRET_DEFAULT,
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    OAUTH_ALLOWED_DOMAINS: 'housingchoice.org,abt-industries.com',
    ...opts.env,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  // Production refuses the committed placeholder (L4 fail-fast) — swap in a
  // non-placeholder value; production-shaped suites never mint sessions.
  if (env.NODE_ENV === 'production' && env.SESSION_SECRET === DEV_SESSION_SECRET_DEFAULT) {
    env.SESSION_SECRET = 'test-production-session-secret';
  }

  const config = loadConfig(env as NodeJS.ProcessEnv);
  const world = opts.world ?? createFakeWorld();
  const capture = createLogCapture();
  // The epoch check re-reads the session user through the 60s cache: seed a
  // users repo that knows BOTH the 'va' and 'admin' test users so authed
  // requests (incl. the M1.4 admin surfaces) stay authed.
  const fakeUsers = makeFakeUsersRepo([testUserItem(), adminUserItem()]);
  const app = buildApp({
    config,
    logger: createLogger({ level: 'info', destination: capture.stream }),
    auth: { usersRepo: fakeUsers.repo },
    // The /api router shares the same fakes + bus, so hub-API and SSE tests
    // can drive the FULL loop (webhook in → bus → SSE out) on one app. The
    // M1.4 surfaces (contacts triage, admin users) share the SAME world
    // contacts + the session user repo so triage/role tests run end-to-end.
    api: {
      // Voice Phase 1: the originate route (initiateCall) + self cell verify-start
      // (adapter.sendMessage) go through the SAME world adapter as the send
      // service, so world.initiatedCalls / world.sent capture them (no network).
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      auditRepo: world.auditRepo,
      contactsRepo: world.contactsRepo,
      settingsRepo: world.settingsRepo,
      contactVocabularyRepo: world.vocabularyRepo,
      unitsRepo: world.unitsRepo,
      placementsRepo: world.placementsRepo,
      activityEventsRepo: world.activityEventsRepo,
      listingSendsRepo: world.listingSendsRepo,
      broadcastsRepo: world.broadcastsRepo,
      toursRepo: world.toursRepo,
      tourRemindersRepo: world.tourRemindersRepo,
      ...(opts.toursNow !== undefined && { toursNow: opts.toursNow }),
      // M1.8a: resolve the share-broadcast audience against the SAME world
      // contacts the authed API + the broadcast.send job read (no DynamoDB).
      // A test may override the resolver to drive the over-cap/truncated paths.
      audienceResolutionService:
        opts.audienceResolutionService ??
        createAudienceResolutionService({
          contactsRepo: world.contactsRepo,
          logger: createLogger({ level: 'info', destination: capture.stream }),
        }),
      usersRepo: fakeUsers.repo,
      events: world.events,
      // M1.9c: the recording-serving endpoint (GET /api/calls/:callId/recording)
      // streams the stored recording back out of the SAME media store the voice
      // recording callback wrote it into.
      ...(opts.withoutMediaStore ? {} : { mediaStore: world.mediaStore }),
      ...(opts.sseHeartbeatMs !== undefined && { sseHeartbeatMs: opts.sseHeartbeatMs }),
      ...(opts.poolNumbersService !== undefined && {
        poolNumbersService: opts.poolNumbersService,
      }),
      ...(opts.systemStatusService !== undefined && {
        systemStatusService: opts.systemStatusService,
      }),
    },
    // M1.5 public surface — shares the SAME world repos so a housing-fair
    // signup writes the same contacts/conversations/units the authed API reads,
    // and the welcome text goes through the world's fake adapter (world.sent)
    // via a real send service wired to the world fakes (no DynamoDB/network).
    public: {
      contactsRepo: world.contactsRepo,
      conversationsRepo: world.conversationsRepo,
      unitsRepo: world.unitsRepo,
      auditRepo: world.auditRepo,
      // The housing-fair welcome reads the operator's welcomeText override (with
      // a constant fallback) — share the world's fake settings repo so a
      // welcomeText edit is reflected without touching DynamoDB.
      settingsRepo: world.settingsRepo,
      sendMessageService: createSendMessageService({
        config,
        logger: createLogger({ level: 'info', destination: capture.stream }),
        adapter: world.adapter,
        conversationsRepo: world.conversationsRepo,
        messagesRepo: world.messagesRepo,
        contactsRepo: world.contactsRepo,
        auditRepo: world.auditRepo,
        events: world.events,
      }),
    },
    webhooks: {
      adapter: world.adapter,
      ...(opts.withoutMediaStore ? {} : { mediaStore: world.mediaStore }),
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      auditRepo: world.auditRepo,
      placementsRepo: world.placementsRepo,
      // M1.10d masked-call landlord-leg routing reads the unit's primary_voice_contact.
      unitsRepo: world.unitsRepo,
      broadcastsRepo: world.broadcastsRepo,
      // M1.9b founder call-triage: the voice router resolves the founder (admin
      // user(s)) via the SAME fake users repo the auth gate uses, reads the
      // founder-editable quick-replies from the world settings, and dispatches
      // the pre-ring / missed-call pushes through the recording fake pushService.
      settingsRepo: world.settingsRepo,
      usersRepo: fakeUsers.repo,
      pushService: world.pushService,
      events: world.events,
      ...(opts.statusUnknownSidRetryDelayMs !== undefined && {
        statusUnknownSidRetryDelayMs: opts.statusUnknownSidRetryDelayMs,
      }),
    },
  });
  return { app, world, capture, config, fakeUsers };
}

export interface SignedPostOptions {
  /** Tamper with the computed signature (rejection tests). */
  tamper?: boolean;
  /** Omit the X-Twilio-Signature header entirely. */
  omitSignature?: boolean;
  /** Base URL used for SIGNING (mismatch tests); requests still hit the app. */
  signatureBaseUrl?: string;
}

/** POST a Twilio-style urlencoded webhook with a REAL computed signature. */
export function signedTwilioPost(
  app: Express,
  path: string,
  params: Record<string, string>,
  opts: SignedPostOptions = {},
): Test {
  const url = `${opts.signatureBaseUrl ?? PUBLIC_BASE_URL}${path}`;
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  let req = request(app).post(path).set('x-origin-verify', ORIGIN_SECRET).type('form');
  if (!opts.omitSignature) {
    req = req.set('x-twilio-signature', opts.tamper ? `${signature}TAMPERED` : signature);
  }
  return req.send(params);
}

/** Standard inbound SMS webhook params (Programmable Messaging shape). */
export function inboundSmsParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SMinbound0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    MessagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    From: TENANT_PHONE,
    To: OUR_NUMBER,
    Body: 'hello, looking for a 2 bed',
    NumMedia: '0',
    SmsStatus: 'received',
    ApiVersion: '2010-04-01',
    ...overrides,
  };
}

/** Standard delivery status callback params. */
export function statusParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    MessageSid: 'SMout0001',
    AccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    MessagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    MessageStatus: 'delivered',
    To: TENANT_PHONE,
    From: OUR_NUMBER,
    ApiVersion: '2010-04-01',
    ...overrides,
  };
}
