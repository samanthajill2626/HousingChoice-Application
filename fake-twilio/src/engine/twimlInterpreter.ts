import { XMLParser } from 'fast-xml-parser';

export interface DialNumber {
  phone: string;
  whisperUrl?: string;
  statusCallback?: string;
}
export type VoicemailGreetingVerb = 'play' | 'say' | 'none';
export type TwimlPlan =
  | { kind: 'dial'; callerId?: string; record?: string; actionUrl?: string; recordingStatusCallback?: string; pauseBeforeMs: number; numbers: DialNumber[] }
  | { kind: 'gather'; actionUrl?: string; numDigits: number; timeoutSec: number; sayContainsPress0: boolean }
  | { kind: 'pause'; lengthSec: number }
  | { kind: 'record'; maxLength?: number; playBeep?: boolean; actionUrl?: string; recordingStatusCallback?: string; greeting: VoicemailGreetingVerb; playUrl?: string }
  | { kind: 'hangup' }
  | { kind: 'say'; text: string }
  | { kind: 'empty' };

// parseTagValue:false keeps text nodes as literal strings — the app emits phone
// numbers like "+15550100002" as <Number> text; the default numeric coercion
// would strip the leading "+" and yield the number 15550100002.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => name === 'Number', parseTagValue: false });

// A SECOND, order-preserving parse used only to answer "which verb comes
// immediately before <Record>?" - the tag-keyed parse above discards sibling
// order, and a voicemail response always carries a thanks <Say> AFTER <Record>,
// so presence alone cannot tell a spoken prompt from a played greeting.
const orderedParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, parseTagValue: false });

type OrderedNode = Record<string, unknown>;

function textOf(node: unknown): string | undefined {
  if (!Array.isArray(node)) return undefined;
  const text = (node as OrderedNode[]).find((n) => '#text' in n);
  return text !== undefined ? String(text['#text']) : undefined;
}

/** The verb immediately preceding <Record> in document order, plus a <Play>'s URL. */
export function greetingBeforeRecord(xml: string): { greeting: VoicemailGreetingVerb; playUrl?: string } {
  const doc = orderedParser.parse(xml) as OrderedNode[];
  const response = doc.find((n) => 'Response' in n);
  const children = (response?.['Response'] as OrderedNode[] | undefined) ?? [];
  const at = children.findIndex((c) => 'Record' in c);
  if (at <= 0) return { greeting: 'none' };
  const prev = children[at - 1]!;
  if ('Play' in prev) {
    const url = textOf(prev['Play']);
    return { greeting: 'play', ...(url !== undefined && { playUrl: url }) };
  }
  if ('Say' in prev) return { greeting: 'say' };
  return { greeting: 'none' };
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Parse the subset of TwiML the app emits into a structured plan. Reads real
 *  attributes/URLs — no hardcoded flow. */
export function interpretTwiml(xml: string): TwimlPlan {
  const root = parser.parse(xml) as { Response?: Record<string, unknown> };
  const r = root.Response ?? {};
  if ('Dial' in r) {
    const dial = r['Dial'] as Record<string, unknown>;
    const numbers: DialNumber[] = asArray(dial['Number'] as unknown).map((n) => {
      if (typeof n === 'string') return { phone: n };
      const o = n as Record<string, unknown>;
      const phone = String(o['#text'] ?? '').trim();
      const whisperUrl = o['@_url'] !== undefined ? String(o['@_url']) : undefined;
      const statusCallback = o['@_statusCallback'] !== undefined ? String(o['@_statusCallback']) : undefined;
      return { phone, ...(whisperUrl !== undefined && { whisperUrl }), ...(statusCallback !== undefined && { statusCallback }) };
    });
    const pauseLen = 'Pause' in r ? Number((r['Pause'] as Record<string, unknown>)['@_length'] ?? 0) : 0;
    return {
      kind: 'dial',
      ...(dial['@_callerId'] !== undefined && { callerId: String(dial['@_callerId']) }),
      ...(dial['@_record'] !== undefined && { record: String(dial['@_record']) }),
      ...(dial['@_action'] !== undefined && { actionUrl: String(dial['@_action']) }),
      ...(dial['@_recordingStatusCallback'] !== undefined && { recordingStatusCallback: String(dial['@_recordingStatusCallback']) }),
      pauseBeforeMs: pauseLen * 1000,
      numbers,
    };
  }
  if ('Gather' in r) {
    const g = r['Gather'] as Record<string, unknown>;
    // <Say> may be a bare string OR, when it carries attributes (voice/language), an
    // object {'#text':..., '@_voice':...}; read the text in both cases so attributes
    // don't silently defeat the press-0 escape detection (String(obj) → "[object Object]").
    const sayNode = g['Say'];
    const say =
      typeof sayNode === 'object' && sayNode !== null
        ? String((sayNode as Record<string, unknown>)['#text'] ?? '')
        : String(sayNode ?? '');
    // NOTE: the app no longer emits "press 0" copy (the relay team escape was
    // removed 2026-08-06, docs/issues/press-0-team-escape-removed.md), so
    // sayContainsPress0 is permanently false for OUR TwiML. Kept: this is a
    // generic TwiML parser, not an app-specific assertion, and the engine
    // never branches on the field.
    return { kind: 'gather', ...(g['@_action'] !== undefined && { actionUrl: String(g['@_action']) }), numDigits: Number(g['@_numDigits'] ?? 1), timeoutSec: Number(g['@_timeout'] ?? 5), sayContainsPress0: /press 0/i.test(say) };
  }
  if ('Pause' in r) return { kind: 'pause', lengthSec: Number((r['Pause'] as Record<string, unknown>)['@_length'] ?? 1) };
  // A voicemail response is Say+Record+Say+Hangup (Play+Record+Say+Hangup with a
  // recorded greeting): check for the self-closing <Record/> BEFORE the Hangup/Say
  // fallbacks (Hangup would otherwise win the first-match ladder).
  if ('Record' in r) {
    const rec = r['Record'] as Record<string, unknown>;
    return {
      kind: 'record',
      ...greetingBeforeRecord(xml),
      ...(rec['@_maxLength'] !== undefined && { maxLength: Number(rec['@_maxLength']) }),
      ...(rec['@_playBeep'] !== undefined && { playBeep: String(rec['@_playBeep']) === 'true' }),
      ...(rec['@_action'] !== undefined && { actionUrl: String(rec['@_action']) }),
      ...(rec['@_recordingStatusCallback'] !== undefined && { recordingStatusCallback: String(rec['@_recordingStatusCallback']) }),
    };
  }
  if ('Hangup' in r) return { kind: 'hangup' };
  if ('Say' in r) return { kind: 'say', text: String(r['Say']) };
  return { kind: 'empty' };
}
