import { XMLParser } from 'fast-xml-parser';

export interface DialNumber {
  phone: string;
  whisperUrl?: string;
  statusCallback?: string;
}
export type TwimlPlan =
  | { kind: 'dial'; callerId?: string; record?: string; actionUrl?: string; recordingStatusCallback?: string; pauseBeforeMs: number; numbers: DialNumber[] }
  | { kind: 'gather'; actionUrl?: string; numDigits: number; timeoutSec: number; sayContainsPress0: boolean }
  | { kind: 'pause'; lengthSec: number }
  | { kind: 'hangup' }
  | { kind: 'say'; text: string }
  | { kind: 'empty' };

// parseTagValue:false keeps text nodes as literal strings — the app emits phone
// numbers like "+15550100002" as <Number> text; the default numeric coercion
// would strip the leading "+" and yield the number 15550100002.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => name === 'Number', parseTagValue: false });

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
    const say = String((g['Say'] as unknown) ?? '');
    return { kind: 'gather', ...(g['@_action'] !== undefined && { actionUrl: String(g['@_action']) }), numDigits: Number(g['@_numDigits'] ?? 1), timeoutSec: Number(g['@_timeout'] ?? 5), sayContainsPress0: /press 0/i.test(say) };
  }
  if ('Pause' in r) return { kind: 'pause', lengthSec: Number((r['Pause'] as Record<string, unknown>)['@_length'] ?? 1) };
  if ('Hangup' in r) return { kind: 'hangup' };
  if ('Say' in r) return { kind: 'say', text: String(r['Say']) };
  return { kind: 'empty' };
}
