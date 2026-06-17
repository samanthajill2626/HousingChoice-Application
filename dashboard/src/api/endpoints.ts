// Typed endpoint functions — one per route. Every function returns a typed
// result and throws ApiError on non-2xx (see api/client.ts). Components import
// these (via api/index.ts) and never construct fetch calls by hand.
import { request } from './client.js';
import type {
  CasesPage,
  Contact,
  ContactMediaItem,
  ContactTimelinePage,
  ConversationsPage,
  DevLoginResult,
  ListingSendRow,
  Me,
  Message,
  SendMessageResult,
  TodayResponse,
  UnitsPage,
} from './types.js';

// --- Auth (/auth) -----------------------------------------------------------

/** GET /auth/me — the current principal, or throws ApiError(401) when anonymous. */
export function getMe(signal?: AbortSignal): Promise<Me> {
  return request<Me>('/auth/me', { ...(signal !== undefined && { signal }) });
}

/** POST /auth/logout — global session revocation (204). */
export function logout(): Promise<void> {
  return request<void>('/auth/logout', { method: 'POST' });
}

/** The login URL — a plain navigation (the server drives the OAuth dance).
 *  Not a fetch: use it as an <a href> / window.location.assign(loginUrl()). */
export function loginUrl(): string {
  return '/auth/login';
}

// --- Today (/api) -----------------------------------------------------------
// The server-assembled action queue (§API Contract C7). When the backend slice
// isn't live yet this 404s; useToday catches ApiError(404) and assembles the
// same shape client-side from getCases() + getConversations().

/** GET /api/today — the server-assembled Today queue, or throws ApiError(404)
 *  until the backend slice lands (the caller falls back to the client build). */
export function getToday(signal?: AbortSignal): Promise<TodayResponse> {
  return request<TodayResponse>('/api/today', { ...(signal !== undefined && { signal }) });
}

/** GET /api/cases — the case board (the Today fallback's deadline/tour/attention
 *  source). The server pages; the Today fallback reads the first page. */
export function getCases(signal?: AbortSignal): Promise<CasesPage> {
  return request<CasesPage>('/api/cases', { ...(signal !== undefined && { signal }) });
}

/** GET /api/conversations — the inbox rows (the Today fallback's unread +
 *  untriaged source). */
export function getConversations(signal?: AbortSignal): Promise<ConversationsPage> {
  return request<ConversationsPage>('/api/conversations', {
    ...(signal !== undefined && { signal }),
  });
}

/** GET /api/conversations/:id/messages — newest-first page of a conversation's
 *  messages (the contact timeline FALLBACK's source). The server wraps the page
 *  under { messages }; we unwrap it here so callers get a plain Message[]. */
export async function getConversationMessages(
  conversationId: string,
  signal?: AbortSignal,
): Promise<Message[]> {
  const res = await request<{ messages: Message[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.messages;
}

/** POST /api/conversations/:id/messages — a manual human send (the reply box). */
export function sendMessage(
  conversationId: string,
  body: { body?: string; mediaUrls?: string[] },
): Promise<SendMessageResult> {
  return request<SendMessageResult>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: 'POST', body },
  );
}

/** GET /api/units — the unit records. The landlord file filters this by
 *  landlordId === contactId to show the landlord's own listings. */
export function getUnits(signal?: AbortSignal): Promise<UnitsPage> {
  return request<UnitsPage>('/api/units', { ...(signal !== undefined && { signal }) });
}

// --- Contacts (/api/contacts) -----------------------------------------------
// The contact detail page (B2 tenant / B3 landlord). getContact exists today
// (legacy Contact, single `phone`); the timeline / listings-sent / media slices
// (C2/C4/C5) 404 until BE1–BE5 land, so callers degrade gracefully.

/** GET /api/contacts/:id — the contact record (the detail page header + file).
 *  Wrapped under { contact } on the wire; unwrapped here. */
export async function getContact(contactId: string, signal?: AbortSignal): Promise<Contact> {
  const res = await request<{ contact: Contact }>(
    `/api/contacts/${encodeURIComponent(contactId)}`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.contact;
}

/** GET /api/contacts/:id/timeline (§C2) — the server-merged person-centric
 *  timeline. 404s until BE2 lands; useContactTimeline catches that and assembles
 *  a message-only fallback from the contact's conversations. `kinds` filters
 *  (e.g. 'message,call' for the "Comms only" toggle). */
export function getContactTimeline(
  contactId: string,
  opts: { kinds?: string } = {},
  signal?: AbortSignal,
): Promise<ContactTimelinePage> {
  return request<ContactTimelinePage>(
    `/api/contacts/${encodeURIComponent(contactId)}/timeline`,
    {
      query: { kinds: opts.kinds },
      ...(signal !== undefined && { signal }),
    },
  );
}

/** GET /api/contacts/:id/listings-sent (§C4) — the "Listings sent" rows. 404s
 *  until BE4 lands → the panel renders a "pending backend" state. */
export async function getContactListingsSent(
  contactId: string,
  signal?: AbortSignal,
): Promise<ListingSendRow[]> {
  const res = await request<{ sent: ListingSendRow[] }>(
    `/api/contacts/${encodeURIComponent(contactId)}/listings-sent`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.sent;
}

/** GET /api/contacts/:id/media (§C5) — aggregated comms media. 404s until BE5
 *  lands → the "Media from comms" panel renders a "pending backend" state. */
export async function getContactMedia(
  contactId: string,
  signal?: AbortSignal,
): Promise<ContactMediaItem[]> {
  const res = await request<{ media: ContactMediaItem[] }>(
    `/api/contacts/${encodeURIComponent(contactId)}/media`,
    { ...(signal !== undefined && { signal }) },
  );
  return res.media;
}

// --- Dev-only auth (/__dev, /auth/dev-login) --------------------------------
// These reach the hermetic-LOCAL dev router, mounted ONLY in the local dev/e2e
// stack and 404 (router absent) in every deployed env. The UI uses devPing() to
// decide whether to surface the dev-login affordance at all; it MUST fail closed
// (any non-200 / non-{dev:true} / error → unavailable).

/** GET /__dev/ping — availability probe for the hermetic dev router. Resolves
 *  `true` only on 200 with a `{ dev: true }` body; resolves `false` for any
 *  non-200, network/transport error, or malformed body (never throws). */
export async function devPing(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await request<{ dev?: unknown }>('/__dev/ping', {
      ...(signal !== undefined && { signal }),
    });
    return res !== null && typeof res === 'object' && res.dev === true;
  } catch {
    return false;
  }
}

/** POST /auth/dev-login — log in as a dev user (sets the session cookie). The
 *  server auto-provisions the user if missing, so this works on an unseeded
 *  local DB too (known personas keep their role; others default to admin). */
export function devLogin(email = 'va@example.com'): Promise<DevLoginResult> {
  return request<DevLoginResult>('/auth/dev-login', { method: 'POST', body: { email } });
}
