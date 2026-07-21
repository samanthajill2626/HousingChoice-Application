// Email seam for e2e specs: thin wrappers over fake-twilio's fake-SES CONTROL API
// (fake-twilio/src/routes/sesControl.ts), the way fakeVoice.ts wraps the voice
// control API. `listEmails` reads what the app "sent" through the fake-SES REST
// surface; `resetMail` clears that store.
//
// Reset note: the SMS `/control/reset` (preflight + cleanSlate) does NOT touch the
// mail store - mail is a SEPARATE engine on a DISJOINT `/control/reset-mail` subpath
// (see sesControl.ts). Email specs call resetMail explicitly for a clean slate.
import type { APIRequestContext } from '@playwright/test';
import { fakeUrl } from '../support/urls.js';

const FAKE_BASE = fakeUrl;

/** One captured outbound email (fake-twilio StoredEmail). `rawMime` is the full
 *  decoded MIME the app POSTed; to/cc/subject/messageIdHeader are string-scanned
 *  from its top-level header block by the fake. */
export interface FakeEmail {
  sesMessageId: string;
  rawMime: string;
  to: string[];
  cc: string[];
  subject: string;
  messageIdHeader?: string;
  receivedAt: string;
  state: 'sent';
}

/** Every email the app has "sent" through the fake-SES surface, NEWEST FIRST. */
export async function listEmails(request: APIRequestContext): Promise<FakeEmail[]> {
  const res = await request.get(`${FAKE_BASE}/control/emails`);
  if (!res.ok()) throw new Error(`list emails failed: ${res.status()}`);
  return ((await res.json()) as { emails: FakeEmail[] }).emails;
}

/** Clear the fake-SES mail store (hermetic clean-slate for email specs). */
export async function resetMail(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${FAKE_BASE}/control/reset-mail`, { data: {} });
  if (!res.ok()) throw new Error(`reset-mail failed: ${res.status()} ${await res.text()}`);
}
