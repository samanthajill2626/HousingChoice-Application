// app/src/adapters/twilioHttpClient.ts
//
// SPIKE RESULT (Task 1.1) — mechanism that worked:
//   The twilio v6 default `RequestClient` (CommonJS: `module.exports =
//   RequestClient`) imports cleanly under this repo's NodeNext + tsx/Vitest
//   toolchain via the default import below. We do NOT subclass it; we
//   instantiate it and wrap its `request` method, rewriting only the ORIGIN
//   (protocol + host + port) of `opts.uri` to point at the fake host. The SDK's
//   own request building (canonical path, form serialization of params/data),
//   retry/timeout behavior, and response parsing all run unchanged — we change
//   only the destination host. This keeps the production driver code path
//   exercised verbatim against the fake-twilio service.
//
//   The documented fetch-based fallback was NOT needed: the `RequestClient`
//   import resolved cleanly.
import RequestClient from 'twilio/lib/base/RequestClient.js';

export interface RedirectingHttpClientOpts {
  /** Base URL of the fake host, e.g. http://localhost:8889 (no trailing slash). */
  baseUrl: string;
}

/**
 * A twilio-node HTTP client that sends every REST request to `baseUrl` instead of
 * the real Twilio hosts, preserving the SDK's canonical path
 * (e.g. /2010-04-01/Accounts/{Sid}/Messages.json), method, params, and response
 * parsing. DEV/TEST ONLY — used to point the real TwilioMessagingDriver at the
 * fake-twilio service so the production driver code path is exercised verbatim.
 */
export function createRedirectingHttpClient(opts: RedirectingHttpClientOpts): RequestClient {
  const base = opts.baseUrl.replace(/\/$/, '');
  const client = new RequestClient();
  // twilio's RequestClient.request takes { method, uri, ... } and returns a
  // promise of { statusCode, body, headers }. Rewrite only the origin of `uri`,
  // delegating to the real implementation (request building, retries, parsing).
  const original = client.request.bind(client);
  client.request = <TData>(requestOpts: RequestClient.RequestOptions<TData>) => {
    const incoming = new URL(requestOpts.uri);
    const rewritten = `${base}${incoming.pathname}${incoming.search}`;
    return original<TData>({ ...requestOpts, uri: rewritten });
  };
  return client;
}
