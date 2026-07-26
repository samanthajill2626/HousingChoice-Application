// fake-twilio/src/engine/dispatcher.ts
import { createHash } from 'node:crypto';
import { signTwilioWebhook, signTwilioJsonWebhook, type WebhookParams } from './signer.js';

export interface WebhookDispatcherDeps {
  /** Where to actually POST (the app's real address). */
  appBaseUrl: string;
  /** The app's PUBLIC_BASE_URL — used to compute the signed URL the app reconstructs. */
  appPublicBaseUrl: string;
  authToken: string;
  /**
   * Origin-secret the hermetic app expects in `x-origin-verify` (the Vite proxy
   * injects this in dev). Defaults to the dev placeholder when unset.
   */
  originSecret?: string;
}

/**
 * POSTs correctly-signed, form-encoded webhooks to the app. Signs against
 * `${appPublicBaseUrl}${path}` (what the app's signature middleware reconstructs)
 * while POSTing to `${appBaseUrl}${path}` (its real address) — the two may differ
 * in the e2e stack (sign vs deliver).
 */
export class WebhookDispatcher {
  constructor(private readonly deps: WebhookDispatcherDeps) {}

  async post(path: string, params: WebhookParams): Promise<number> {
    return this.postForResponse(path, params).then((r) => r.status);
  }

  /** Like post(), but also returns the response body — for TwiML-returning voice
   *  webhooks (/voice, /voice/whisper, /voice/whisper-gate) the CallEngine must read. */
  async postForResponse(path: string, params: WebhookParams): Promise<{ status: number; body: string }> {
    const signedUrl = `${this.deps.appPublicBaseUrl}${path}`;
    const signature = signTwilioWebhook({ authToken: this.deps.authToken, url: signedUrl, params });
    const body = new URLSearchParams(params).toString();
    const res = await fetch(`${this.deps.appBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
        // The hermetic app sits behind an origin-secret check; mirror the Vite dev header.
        'x-origin-verify': this.deps.originSecret ?? 'dev-placeholder-not-a-secret',
      },
      body,
      // A hung connection during `e2e:restart` must not block forever (FIX 7).
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, body: await res.text() };
  }

  /**
   * POST a JSON-bodied webhook signed with Twilio's bodySHA256 scheme - used for the
   * Voice Intelligence completion callback (/webhooks/twilio/voice/intelligence). The
   * URL carries `?bodySHA256=<sha256hex(rawBody)>`; X-Twilio-Signature is HMAC-SHA1
   * over that full URL with NO form params, matching the app's validateRequestWithBody.
   * Returns the response status (fire-and-read; the caller ignores the body).
   */
  async postJson(path: string, body: Record<string, unknown>): Promise<number> {
    const raw = JSON.stringify(body);
    const sha = createHash('sha256').update(raw, 'utf8').digest('hex');
    const query = `?bodySHA256=${sha}`;
    const signature = signTwilioJsonWebhook({
      authToken: this.deps.authToken,
      url: `${this.deps.appPublicBaseUrl}${path}${query}`,
    });
    const res = await fetch(`${this.deps.appBaseUrl}${path}${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-twilio-signature': signature,
        'x-origin-verify': this.deps.originSecret ?? 'dev-placeholder-not-a-secret',
      },
      body: raw,
      signal: AbortSignal.timeout(5000),
    });
    return res.status;
  }

  /**
   * POST a CloudEvents batch (the A2P Event Streams number-registration signal,
   * relay-number-buying T9) to the app's events sink as raw JSON. Carries
   * content-type application/json + the x-origin-verify origin secret, but NO
   * X-Twilio-Signature: the events sink authorizes by a shared secret / origin-verify
   * (app T3's pragmatic auth form), NOT the classic form-signature scheme - so this
   * deliberately skips the signing path used by post()/postJson(). Returns the
   * response status (fire-and-read; the caller maps a non-2xx to an error).
   */
  async postEventsBatch(path: string, batch: unknown): Promise<number> {
    const res = await fetch(`${this.deps.appBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-origin-verify': this.deps.originSecret ?? 'dev-placeholder-not-a-secret',
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(5000),
    });
    return res.status;
  }
}
