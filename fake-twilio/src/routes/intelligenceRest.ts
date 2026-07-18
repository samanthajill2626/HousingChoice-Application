// fake-twilio/src/routes/intelligenceRest.ts
//
// Task 12: the REAL Twilio Voice Intelligence REST surface the app's twilio v6
// client hits (via the origin-rewriting httpClient in twilioHttpClient.ts). Paths +
// wire shapes verified against node_modules/twilio/lib/rest/intelligence/v2/:
//
//   POST /v2/Transcripts                 <- client.intelligence.v2.transcripts.create(...)
//     form: ServiceSid, Channel (JSON.stringify of {media_properties:{source_sid}}), CustomerKey
//   GET  /v2/Transcripts/:sid            <- transcripts(sid).fetch()
//   GET  /v2/Transcripts/:sid/Sentences  <- transcripts(sid).sentences.list()
//
// NOTE (spec 6 drift D1): the SDK posts ServiceSid as a FORM FIELD to /v2/Transcripts,
// NOT /v2/Services/:sid/Transcripts. The create mints a GTfake sid, builds sentences
// from the pending recording's scenario text, and (via the engine) schedules the signed
// JSON completion webhook. Responses are snake_case Twilio JSON; the Sentences page
// carries meta.key='sentences' + next_page_url=null so the SDK's Page parser resolves.
import { Router } from 'express';
import type { CallEngine, ViTranscriptRecord } from '../engine/callEngine.js';

export interface IntelligenceRestDeps {
  callEngine: CallEngine;
  /** The GA... VI service sid the app is configured with; POST /v2/Transcripts
   *  validates the ServiceSid form field against it. */
  serviceSid: string;
}

/** Twilio-shaped 400 (the SDK parses {code,message,more_info,status} into a RestException). */
function badRequest(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  message: string,
  code = 20001,
): void {
  res.status(400).json({
    code,
    message,
    more_info: `https://www.twilio.com/docs/errors/${code}`,
    status: 400,
  });
}

/** The snake_case Transcript instance JSON the SDK's TranscriptInstance maps from. */
function transcriptInstanceJson(r: ViTranscriptRecord): Record<string, unknown> {
  const now = new Date().toUTCString();
  return {
    account_sid: 'ACfake',
    service_sid: r.serviceSid,
    sid: r.sid,
    status: r.status,
    customer_key: r.customerKey,
    channel: { media_properties: { source_sid: r.sourceSid } },
    date_created: now,
    date_updated: now,
    duration: 1,
    language_code: 'en-US',
    media_start_time: null,
    redaction: false,
    url: `/v2/Transcripts/${r.sid}`,
    links: { sentences: `/v2/Transcripts/${r.sid}/Sentences` },
  };
}

/** The Sentences list page. The SDK's Page parser (base/Page.js) needs meta.key to
 *  find the array and stops paging when meta.next_page_url is falsy. */
function sentencesPageJson(r: ViTranscriptRecord): Record<string, unknown> {
  return {
    sentences: r.sentences.map((s) => ({
      media_channel: s.mediaChannel,
      sentence_index: s.sentenceIndex,
      transcript: s.transcript,
      sid: `GXfake${String(s.sentenceIndex).padStart(4, '0')}`,
      confidence: '0.9',
      start_time: '0',
      end_time: '1',
      words: [],
    })),
    meta: {
      key: 'sentences',
      page: 0,
      page_size: 50,
      first_page_url: '',
      previous_page_url: null,
      next_page_url: null,
      url: '',
    },
  };
}

export function createIntelligenceRestRouter(deps: IntelligenceRestDeps): Router {
  const { callEngine } = deps;
  const expectedServiceSid = deps.serviceSid;
  const router = Router();

  // POST /v2/Transcripts - create a transcript from a recording's source_sid.
  router.post('/v2/Transcripts', (req, res) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const serviceSid = body['ServiceSid'];
    const customerKey = body['CustomerKey'];
    const channelRaw = body['Channel'];
    if (!serviceSid || !customerKey || !channelRaw) {
      badRequest(res, "Transcripts.create requires 'ServiceSid', 'Channel', and 'CustomerKey'.");
      return;
    }
    if (expectedServiceSid.length > 0 && serviceSid !== expectedServiceSid) {
      badRequest(res, `ServiceSid ${serviceSid} does not match the configured VI service.`, 20404);
      return;
    }
    let sourceSid: string | undefined;
    try {
      const channel = JSON.parse(channelRaw) as { media_properties?: { source_sid?: string } };
      sourceSid = channel.media_properties?.source_sid;
    } catch {
      sourceSid = undefined;
    }
    if (typeof sourceSid !== 'string' || sourceSid.length === 0) {
      badRequest(res, "Channel.media_properties.source_sid is required.");
      return;
    }
    const record = callEngine.createViTranscript({ serviceSid, customerKey, sourceSid });
    res.status(201).json(transcriptInstanceJson(record));
  });

  // GET /v2/Transcripts/:sid - fetch the transcript instance.
  router.get('/v2/Transcripts/:sid', (req, res) => {
    const sid = req.params['sid'];
    const record = sid !== undefined ? callEngine.getViTranscript(sid) : undefined;
    if (!record) {
      badRequest(res, `Transcript ${sid ?? ''} not found.`, 20404);
      return;
    }
    res.status(200).json(transcriptInstanceJson(record));
  });

  // GET /v2/Transcripts/:sid/Sentences - list the transcript's sentences.
  router.get('/v2/Transcripts/:sid/Sentences', (req, res) => {
    const sid = req.params['sid'];
    const record = sid !== undefined ? callEngine.getViTranscript(sid) : undefined;
    if (!record) {
      badRequest(res, `Transcript ${sid ?? ''} not found.`, 20404);
      return;
    }
    res.status(200).json(sentencesPageJson(record));
  });

  return router;
}
