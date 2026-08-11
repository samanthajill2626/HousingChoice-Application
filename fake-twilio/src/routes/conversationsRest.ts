// fake-twilio/src/routes/conversationsRest.ts
//
// Twilio Conversations REST impersonation - only the subset the app's
// GroupConversationsPort adapter calls. Same conventions as rest.ts: the real
// resource shapes in snake_case JSON, and errors as
// `{ code, message, more_info, status }` so twilio-node builds a RestException
// the adapter's `twilioErrorCode`/`twilioStatus` helpers can read.
//
// THE PATHS ARE THE SDK'S, NOT OURS. `createRedirectingHttpClient` rewrites only
// the ORIGIN of each request, so the canonical path arrives verbatim:
//   POST   /v1/Conversations
//   POST   /v1/ConversationWithParticipants      (the bulk create)
//   GET    /v1/Conversations/{SidOrUniqueName}   (adopt-or-create's adopt half)
//   DELETE /v1/Conversations/{SidOrUniqueName}   (the prod preflight capability check)
//   POST   /v1/Conversations/{Sid}/Participants
//   GET    /v1/Conversations/{Sid}/Participants
//   POST   /v1/Conversations/{Sid}/Messages
// `/v1` is already in server.ts's reserved-prefix list, so the SPA fallback
// never swallows these.
import { Router } from 'express';
import {
  ConversationsEngine,
  DuplicateUniqueNameError,
  InvalidMessagingBindingError,
} from '../engine/conversationsEngine.js';
import type { ConversationRecord } from '../engine/conversationsStore.js';

/** Body values are strings, but a repeated `Participant=` collapses to an array. */
function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Read a `MessagingBinding.X` form field, tolerating the casings the two adapter
 * paths produce: the SDK serializes `messagingBinding.address` to
 * `MessagingBinding.Address`, and a hand-built params object may keep the
 * camelCase key. Accepting both means a spec never fails on a serialization
 * detail while the behaviour under test is fine.
 */
function bindingField(body: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = firstString(body[key]);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** Each bulk `Participant` entry is a JSON string: `{ messaging_binding: {...} }`. */
function parseParticipantJson(raw: string): { address?: string; projectedAddress?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidMessagingBindingError(`Invalid messaging binding address: ${raw}`);
  }
  const binding = (parsed as { messaging_binding?: Record<string, unknown> } | null)?.messaging_binding;
  if (typeof binding !== 'object' || binding === null) {
    throw new InvalidMessagingBindingError('Invalid messaging binding address: no messaging_binding');
  }
  const address = binding['address'];
  const projected = binding['projected_address'] ?? binding['projectedAddress'];
  return {
    ...(typeof address === 'string' && { address }),
    ...(typeof projected === 'string' && { projectedAddress: projected }),
  };
}

function conversationResource(record: ConversationRecord): Record<string, unknown> {
  return {
    sid: record.sid,
    account_sid: 'ACfake000000000000000000000000000',
    chat_service_sid: 'ISfake000000000000000000000000000',
    messaging_service_sid: record.messagingServiceSid ?? null,
    unique_name: record.uniqueName ?? null,
    friendly_name: record.friendlyName ?? null,
    state: record.state,
    date_created: record.dateCreated,
    date_updated: record.dateCreated,
  };
}

function participantResource(
  conversationSid: string,
  participant: ConversationRecord['participants'][number],
): Record<string, unknown> {
  return {
    sid: participant.sid,
    conversation_sid: conversationSid,
    account_sid: 'ACfake000000000000000000000000000',
    identity: null,
    // snake_case, exactly as the resource serializes it. The adapter's
    // `bindingField` reads camel OR snake, and this is the snake half.
    messaging_binding: {
      ...(participant.address !== undefined && { address: participant.address }),
      ...(participant.projectedAddress !== undefined && {
        projected_address: participant.projectedAddress,
      }),
      ...(participant.address !== undefined && { proxy_address: null }),
    },
    date_created: participant.dateCreated,
  };
}

function notFound(res: import('express').Response, resource: string): void {
  res.status(404).json({
    code: 20404,
    message: `The requested resource ${resource} was not found`,
    more_info: 'https://www.twilio.com/docs/errors/20404',
    status: 404,
  });
}

export function createConversationsRestRouter(engine: ConversationsEngine): Router {
  const router = Router();

  // POST /v1/Conversations
  router.post('/v1/Conversations', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const record = engine.create({
        ...(firstString(body['UniqueName']) !== undefined && {
          uniqueName: firstString(body['UniqueName'])!,
        }),
        ...(firstString(body['FriendlyName']) !== undefined && {
          friendlyName: firstString(body['FriendlyName'])!,
        }),
        ...(firstString(body['MessagingServiceSid']) !== undefined && {
          messagingServiceSid: firstString(body['MessagingServiceSid'])!,
        }),
      });
      res.status(201).json(conversationResource(record));
    } catch (err) {
      respondCreateError(res, err);
    }
  });

  // POST /v1/ConversationWithParticipants - the bulk create the adapter prefers.
  // ALL-OR-NOTHING like the real API: one rail-ineligible participant fails the
  // whole request with no per-member detail, which is precisely why the adapter
  // has an individual-add fallback worth exercising.
  router.post('/v1/ConversationWithParticipants', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let participants: { address?: string; projectedAddress?: string }[];
    try {
      participants = allStrings(body['Participant']).map(parseParticipantJson);
    } catch (err) {
      respondCreateError(res, err);
      return;
    }
    try {
      const record = engine.create({
        ...(firstString(body['UniqueName']) !== undefined && {
          uniqueName: firstString(body['UniqueName'])!,
        }),
        ...(firstString(body['FriendlyName']) !== undefined && {
          friendlyName: firstString(body['FriendlyName'])!,
        }),
        ...(firstString(body['MessagingServiceSid']) !== undefined && {
          messagingServiceSid: firstString(body['MessagingServiceSid'])!,
        }),
        participants,
      });
      res.status(201).json(conversationResource(record));
    } catch (err) {
      respondCreateError(res, err);
    }
  });

  // GET /v1/Conversations/:sidOrUniqueName - a UniqueName stands in for the SID.
  router.get('/v1/Conversations/:sid', (req, res) => {
    const record = engine.resolve(req.params.sid);
    if (!record) {
      notFound(res, `/Conversations/${req.params.sid}`);
      return;
    }
    res.status(200).json(conversationResource(record));
  });

  // DELETE /v1/Conversations/:sidOrUniqueName - the production preflight's
  // capability check creates and then deletes one test conversation.
  router.delete('/v1/Conversations/:sid', (req, res) => {
    if (!engine.remove(req.params.sid)) {
      notFound(res, `/Conversations/${req.params.sid}`);
      return;
    }
    res.status(204).end();
  });

  // POST /v1/Conversations/:sid/Participants
  router.post('/v1/Conversations/:sid/Participants', (req, res) => {
    const record = engine.resolve(req.params.sid);
    if (!record) {
      notFound(res, `/Conversations/${req.params.sid}`);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const address = bindingField(body, 'MessagingBinding.Address', 'messagingBinding.address');
    const projectedAddress = bindingField(
      body,
      'MessagingBinding.ProjectedAddress',
      'messagingBinding.projectedAddress',
    );
    try {
      const participant = engine.addParticipant(record, {
        ...(address !== undefined && { address }),
        ...(projectedAddress !== undefined && { projectedAddress }),
      });
      res.status(201).json(participantResource(record.sid, participant));
    } catch (err) {
      respondCreateError(res, err);
    }
  });

  // GET /v1/Conversations/:sid/Participants - the read-back the adapter builds
  // its MBxx map from (a create response carries no participant SIDs).
  router.get('/v1/Conversations/:sid/Participants', (req, res) => {
    const record = engine.resolve(req.params.sid);
    if (!record) {
      notFound(res, `/Conversations/${req.params.sid}`);
      return;
    }
    const participants = record.participants.map((p) => participantResource(record.sid, p));
    res.status(200).json({
      participants,
      meta: {
        page: 0,
        page_size: participants.length,
        first_page_url: `/v1/Conversations/${record.sid}/Participants?PageSize=50&Page=0`,
        previous_page_url: null,
        url: `/v1/Conversations/${record.sid}/Participants?PageSize=50&Page=0`,
        next_page_url: null,
        key: 'participants',
      },
    });
  });

  // POST /v1/Conversations/:sid/Messages
  router.post('/v1/Conversations/:sid/Messages', (req, res) => {
    const record = engine.resolve(req.params.sid);
    if (!record) {
      notFound(res, `/Conversations/${req.params.sid}`);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Real contract: only a caller that sets X-Twilio-Webhook-Enabled gets its
    // own post echoed back as onMessageAdded. The adapter deliberately does not.
    const webhookEnabled = String(req.header('x-twilio-webhook-enabled') ?? '').toLowerCase() === 'true';
    const message = engine.postMessage(record, {
      ...(firstString(body['Author']) !== undefined && { author: firstString(body['Author'])! }),
      ...(firstString(body['Body']) !== undefined && { body: firstString(body['Body'])! }),
      webhookEnabled,
    });
    res.status(201).json({
      sid: message.sid,
      conversation_sid: record.sid,
      account_sid: 'ACfake000000000000000000000000000',
      author: message.author ?? null,
      body: message.body ?? null,
      index: message.index,
      date_created: message.dateCreated,
      date_updated: message.dateCreated,
    });
  });

  return router;
}

/** Map an engine refusal onto the Twilio-shaped error the SDK expects. */
function respondCreateError(res: import('express').Response, err: unknown): void {
  if (err instanceof DuplicateUniqueNameError) {
    // 50353 is the real code for a UniqueName collision, and the app's
    // adopt-or-create claim logic is written against exactly this conflict.
    res.status(409).json({
      code: 50353,
      message: err.message,
      more_info: 'https://www.twilio.com/docs/errors/50353',
      status: 409,
    });
    return;
  }
  if (err instanceof InvalidMessagingBindingError) {
    res.status(400).json({
      code: 50407,
      message: err.message,
      more_info: 'https://www.twilio.com/docs/errors/50407',
      status: 400,
    });
    return;
  }
  res.status(400).json({
    code: 20001,
    message: err instanceof Error ? err.message : String(err),
    more_info: 'https://www.twilio.com/docs/errors/20001',
    status: 400,
  });
}
