// fake-twilio/src/routes/voiceRest.ts
//
// Phase 6 / Task 6.1: the REAL Twilio voice REST surface the app's adapter calls
// (replacing the three 501 stubs in rest.ts). It impersonates the exact subset
// the production TwilioMessagingDriver + voice click-to-call exercise — verified
// against app/src/adapters/messaging.ts (twilio v6 client) and the SDK's
// canonical paths (preserved by app/src/adapters/twilioHttpClient.ts):
//
//   POST .../Calls.json                      ← client.calls.create({to,from,url})
//   GET  .../AvailablePhoneNumbers/US/Local.json ← availablePhoneNumbers('US').local.list(...)
//   POST .../IncomingPhoneNumbers.json       ← incomingPhoneNumbers.create({phoneNumber,smsUrl,voiceUrl})
//   GET  .../IncomingPhoneNumbers.json       ← incomingPhoneNumbers.list({phoneNumber})
//   POST .../IncomingPhoneNumbers/:sid.json  ← incomingPhoneNumbers(sid).update({voiceUrl})
//   GET  /recordings/:callSid/:recordingSid.mp3 ← the CallEngine-minted recording URL
//
// Twilio-shaped snake_case JSON + the 400 `more_info` error convention mirror
// rest.ts's Messages.json handler (the twilio SDK builds RestException from
// {code,message,more_info,status}).
import { createReadStream } from 'node:fs';
import { Router } from 'express';
import type { CallEngine } from '../engine/callEngine.js';
import type { NumberRegistry } from '../engine/numberRegistry.js';

export interface VoiceRestDeps {
  callEngine: CallEngine;
  registry: NumberRegistry;
  /** Absolute path to the canned MP3 the recording-serve route streams. */
  cannedRecordingPath: string;
}

/** Twilio-shaped 400 (the SDK parses {code,message,more_info,status} into a RestException). */
function badRequest(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  message: string,
  code = 21603,
): void {
  res.status(400).json({
    code,
    message,
    more_info: `https://www.twilio.com/docs/errors/${code}`,
    status: 400,
  });
}

/**
 * Deterministic AvailablePhoneNumbers candidates: the mintable end of the
 * +1555019xxxx pool the NumberRegistry commits from. We surface a few suffixes
 * NOT yet committed (so a listed number is genuinely mintable, and committing it
 * via IncomingPhoneNumbers.json makes registry.isPool(it) true). AreaCode, when
 * given, replaces the 555 NANP-test prefix segment so tests can assert it threads
 * through (cosmetic — the pool stays distinct either way).
 */
function availableCandidates(registry: NumberRegistry, areaCode: string | undefined, want: number): string[] {
  const out: string[] = [];
  let n = 1;
  while (out.length < want && n < 10000) {
    const suffix = String(n).padStart(4, '0');
    const phone = areaCode !== undefined ? `+1${areaCode}019${suffix}` : `+1555019${suffix}`;
    if (!registry.isPool(phone)) out.push(phone);
    n += 1;
  }
  return out;
}

export function createVoiceRestRouter(deps: VoiceRestDeps): Router {
  const { callEngine, registry, cannedRecordingPath } = deps;
  const router = Router();

  // POST .../Calls.json — click-to-call (client.calls.create). Form: To,From,Url.
  router.post('/2010-04-01/Accounts/:accountSid/Calls.json', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const to = body['To'];
    const from = body['From'];
    const url = body['Url'];
    if (!to || !from || !url) {
      badRequest(res, "Calls.create requires 'To', 'From', and 'Url'.");
      return;
    }
    // Fire the origination (drives the inbound /voice fetch + any bridge) but do
    // NOT await its full lifecycle here — Twilio returns the queued Call resource
    // immediately, then the call runs asynchronously. The engine has already
    // minted + recorded the call by the time originateCall yields its first await,
    // so we read the freshly-created call's sid from getCalls().
    void callEngine.originateCall({ to, from, url }).catch(() => {
      /* a failed bridge must not crash the REST handler — the call entity records it */
    });
    const created = callEngine.getCalls().find((c) => c.to === to && c.from === from && c.kind === 'outbound');
    const sid = created?.callSid ?? '';
    res.status(201).json({
      sid,
      status: 'queued',
      direction: 'outbound-api',
      to,
      from,
      date_created: new Date().toUTCString(),
    });
  });

  // GET .../AvailablePhoneNumbers/:country/Local.json — number search.
  router.get('/2010-04-01/Accounts/:accountSid/AvailablePhoneNumbers/:country/Local.json', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const areaCode = typeof q['AreaCode'] === 'string' && q['AreaCode'].length > 0 ? q['AreaCode'] : undefined;
    const limit = Number(q['PageSize'] ?? q['Limit'] ?? 10);
    const want = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 10) : 1;
    const numbers = availableCandidates(registry, areaCode, Math.max(want, 1));
    res.status(200).json({
      available_phone_numbers: numbers.map((phone_number) => ({
        friendly_name: phone_number,
        phone_number,
        lata: null,
        rate_center: null,
        latitude: null,
        longitude: null,
        region: null,
        postal_code: null,
        iso_country: 'US',
        capabilities: { voice: true, SMS: true, sms: true, MMS: true, mms: true, fax: false },
        beta: false,
      })),
    });
  });

  // POST .../IncomingPhoneNumbers.json — commit the app-chosen number (purchase).
  // Form: PhoneNumber + optional SmsUrl/VoiceUrl. Registers it as a pool number so
  // an inbound call to it routes masked (CallEngine.isPool === true).
  router.post('/2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers.json', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const phoneNumber = body['PhoneNumber'];
    if (!phoneNumber) {
      badRequest(res, "IncomingPhoneNumbers.create requires a 'PhoneNumber'.");
      return;
    }
    const { sid } = registry.provisionSpecific(phoneNumber);
    const smsUrl = body['SmsUrl'];
    const voiceUrl = body['VoiceUrl'];
    if (smsUrl !== undefined || voiceUrl !== undefined) {
      registry.setWebhooks(phoneNumber, {
        ...(smsUrl !== undefined && { smsUrl }),
        ...(voiceUrl !== undefined && { voiceUrl }),
      });
    }
    res.status(201).json({
      sid,
      phone_number: phoneNumber,
      friendly_name: phoneNumber,
      sms_url: smsUrl ?? null,
      voice_url: voiceUrl ?? null,
      capabilities: { voice: true, sms: true, mms: true, fax: false },
      date_created: new Date().toUTCString(),
    });
  });

  // GET .../IncomingPhoneNumbers.json?PhoneNumber=... — lookup by E.164 (the
  // setVoiceWebhook path: list to resolve the resource sid, then update by sid).
  router.get('/2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers.json', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const phoneNumber = typeof q['PhoneNumber'] === 'string' ? q['PhoneNumber'] : undefined;
    const records = phoneNumber !== undefined ? [registry.get(phoneNumber)].filter((r) => r !== undefined) : registry.list();
    res.status(200).json({
      incoming_phone_numbers: records.map((rec) => ({
        sid: rec.sid,
        phone_number: rec.phoneNumber,
        friendly_name: rec.phoneNumber,
        sms_url: rec.smsUrl ?? null,
        voice_url: rec.voiceUrl ?? null,
        capabilities: { voice: true, sms: true, mms: true, fax: false },
      })),
    });
  });

  // POST .../IncomingPhoneNumbers/:sid.json — update a resource (setVoiceWebhook).
  router.post('/2010-04-01/Accounts/:accountSid/IncomingPhoneNumbers/:sid.json', (req, res) => {
    const sid = req.params['sid'];
    const body = (req.body ?? {}) as Record<string, string>;
    const record = sid !== undefined ? registry.getBySid(sid) : undefined;
    if (!record) {
      badRequest(res, `IncomingPhoneNumber ${sid ?? ''} not found.`, 20404);
      return;
    }
    const voiceUrl = body['VoiceUrl'];
    const smsUrl = body['SmsUrl'];
    if (voiceUrl !== undefined || smsUrl !== undefined) {
      registry.setWebhooks(record.phoneNumber, {
        ...(voiceUrl !== undefined && { voiceUrl }),
        ...(smsUrl !== undefined && { smsUrl }),
      });
    }
    const updated = registry.getBySid(record.sid);
    res.status(200).json({
      sid: record.sid,
      phone_number: record.phoneNumber,
      friendly_name: record.phoneNumber,
      sms_url: updated?.smsUrl ?? null,
      voice_url: updated?.voiceUrl ?? null,
      capabilities: { voice: true, sms: true, mms: true, fax: false },
    });
  });

  // GET /recordings/:callSid/:recordingSid.mp3 — stream the canned MP3 as
  // audio/mpeg. The path shape matches the CallEngine-minted RecordingUrl exactly:
  // `${recordingServeBase}/recordings/${callSid}/${recordingSid}.mp3`. Express 5
  // strips the literal `.mp3` suffix from the route, so :recordingSid is the bare
  // RE… sid (the `.mp3` is part of the path, not the param) — we don't need it,
  // we always serve the same canned bytes.
  router.get('/recordings/:callSid/:recordingSid.mp3', (_req, res) => {
    res.status(200).type('audio/mpeg');
    const stream = createReadStream(cannedRecordingPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  });

  return router;
}
