// fake-twilio/src/routes/conversationsControl.ts
//
// The CONTROL surface for native carrier group texting. Shares the `/control`
// prefix with control.ts / voiceControl.ts / sesControl.ts but owns DISJOINT
// subpaths (`/control/send-group-as-party`, `/control/conversations[...]`) -
// same convention sesControl.ts documents, and the reason mounting order here
// is not load-bearing.
//
// NAMING (deliberate, r7 G.4): the fake-phones rail ALREADY has a section
// literally called "Group texts" meaning RELAY groups (pool-number inference).
// Everything this file adds says CARRIER group, so a spec's `getByText` can
// never be ambiguous between two different products.
import { Router } from 'express';
import type { FakeTwilioEngine } from '../engine/engine.js';
import type { ConversationsEngine } from '../engine/conversationsEngine.js';
import type { SendAsPartyInput } from '../engine/types.js';

/** The inbound-injection DTO: a 1:1 send-as-party plus the carrier envelope. */
export interface SendGroupAsPartyInput extends SendAsPartyInput {
  /**
   * Suppress the `onMessageAdded` the fake would otherwise post when the sender
   * is on a rail. This is how a spec manufactures the guardrail's WHOLE POINT -
   * a classic inbound that the Conversations channel never reported.
   */
  railEvent?: boolean;
}

export function createConversationsControlRouter(deps: {
  engine: FakeTwilioEngine;
  conversations: ConversationsEngine;
}): Router {
  const router = Router();
  const { engine, conversations } = deps;

  /**
   * POST /control/send-group-as-party
   *
   * A CARRIER group text arriving at the business number. Two things happen in
   * the real world and both happen here:
   *   1. the classic messaging webhook fires with the undocumented
   *      `OtherRecipients` envelope (this is what detection reads); and
   *   2. IF the roster already has a Conversations rail, the message also binds
   *      to that Conversation and the service-scoped webhook fires
   *      `onMessageAdded` with `Source: SMS`.
   * An UNRAILED roster produces only (1) - which is the honest coverage gap
   * spec 8 states, not a bug in the fake.
   *
   * Body: { from, otherRecipients[], to?, body?, mediaUrls?,
   *         otherRecipientsShape?: 'indexed'|'single', sidShape?: 'SM'|'MM',
   *         railEvent?: boolean }
   */
  router.post('/control/send-group-as-party', async (req, res) => {
    const input = (req.body ?? {}) as SendGroupAsPartyInput;
    try {
      const sid = await engine.sendAsParty(input);
      // The classic filing happens inside that await, so dispatching the
      // Conversations event AFTER it is the deterministic order for the
      // cross-check's ledger (the filing banks a credit the event consumes).
      let conversationSid: string | undefined;
      let eventSid: string | undefined;
      if (input.railEvent !== false) {
        const rail = conversations.railFor(input.from);
        if (rail) {
          conversationSid = rail.sid;
          eventSid = await conversations.dispatchMessageAdded({
            record: rail,
            source: 'SMS',
            author: input.from,
            index: rail.messages.length,
            ...(input.body !== undefined && { body: input.body }),
            ...(conversations.participantFor(rail, input.from) !== undefined && {
              participantSid: conversations.participantFor(rail, input.from)!,
            }),
          });
        }
      }
      res.status(200).json({
        sid,
        ...(conversationSid !== undefined && { conversationSid }),
        ...(eventSid !== undefined && { conversationMessageSid: eventSid }),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /**
   * GET /control/conversations - the inspection surface e2e asserts a rail
   * through (mirrors GET /control/groups for relay). Shape: `{ conversations:
   * [{ sid, uniqueName, state, participants: [{sid, address?, projectedAddress?}],
   * messages: [{sid, author?, body?, index, source, legs?}] }] }`.
   */
  router.get('/control/conversations', (_req, res) => {
    res.status(200).json({ conversations: conversations.listSnapshots() });
  });

  /**
   * POST /control/conversations/inject-event
   *
   * Fire an `onMessageAdded` with no classic counterpart - a message that
   * reached the Conversation and never reached the classic webhook. That is
   * EXACTLY the failure guardrail 2 exists to catch (a silently removed
   * OtherRecipients contract), and there is no other way to manufacture it.
   *
   * `source` also accepts `API`, so the cross-check's `Source === 'SMS'` filter
   * is exercised for real rather than assumed.
   *
   * Body: { conversationSid | uniqueName, author?, body?, source?, messageSid?,
   *         participantSid? }
   */
  router.post('/control/conversations/inject-event', async (req, res) => {
    const body = (req.body ?? {}) as {
      conversationSid?: unknown;
      uniqueName?: unknown;
      author?: unknown;
      body?: unknown;
      source?: unknown;
      messageSid?: unknown;
      participantSid?: unknown;
    };
    const key =
      typeof body.conversationSid === 'string' && body.conversationSid.length > 0
        ? body.conversationSid
        : typeof body.uniqueName === 'string'
          ? body.uniqueName
          : '';
    const record = key.length > 0 ? conversations.resolve(key) : undefined;
    if (!record) {
      res.status(400).json({ error: `inject-event: no conversation for ${key || '(missing id)'}` });
      return;
    }
    const source =
      body.source === 'API' || body.source === 'SDK' || body.source === 'SMS' ? body.source : 'SMS';
    try {
      const messageSid = await conversations.dispatchMessageAdded({
        record,
        source,
        index: record.messages.length,
        ...(typeof body.author === 'string' && { author: body.author }),
        ...(typeof body.body === 'string' && { body: body.body }),
        ...(typeof body.messageSid === 'string' && { messageSid: body.messageSid }),
        ...(typeof body.participantSid === 'string' && { participantSid: body.participantSid }),
      });
      res.status(200).json({ ok: true, messageSid, conversationSid: record.sid });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** GET /control/conversations/dispatch-errors - the Conversations engine's own
   *  ring buffer, so a signature/mount regression on the new route is observable
   *  rather than swallowed (mirrors GET /control/dispatch-errors). */
  router.get('/control/conversations/dispatch-errors', (_req, res) => {
    res.status(200).json({ errors: conversations.getDispatchErrors() });
  });

  return router;
}
