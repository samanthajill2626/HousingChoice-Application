// Control-API fetchers for the fake-phones UI. Same-origin calls to the
// fake-twilio host's /control/* surface (see fake-twilio/src/routes/control.ts).
import type { AddAdHocInput, DeliveryProfile, Persona, SendAsPartyInput, Thread } from './types.js';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof json['error'] === 'string' ? json['error'] : `${path} failed: ${res.status}`);
  }
  return json as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getPersonas(): Promise<Persona[]> {
  return (await get<{ personas: Persona[] }>('/control/personas')).personas;
}

export async function getThreads(): Promise<Thread[]> {
  return (await get<{ threads: Thread[] }>('/control/threads')).threads;
}

export async function sendAsParty(input: SendAsPartyInput): Promise<string> {
  return (await post<{ sid: string }>('/control/send-as-party', input)).sid;
}

export async function addAdHoc(input: AddAdHocInput): Promise<Persona> {
  return post<Persona>('/control/personas/ad-hoc', input);
}

export async function setDeliveryOutcome(partyNumber: string, profile: DeliveryProfile): Promise<void> {
  await post('/control/delivery-outcome', { partyNumber, profile });
}

export async function resetAll(): Promise<void> {
  await post('/control/reset', {});
}
