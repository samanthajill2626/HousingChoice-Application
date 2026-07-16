// Typed fetch wrapper — the low-level transport every api/*.ts function uses.
// Same-origin, cookie auth (credentials: 'same-origin'); the browser sends the
// Origin header automatically so mutations pass the server's CSRF check. On a
// non-2xx response it throws ApiError, parsing the server's { error } body into
// a stable `code`. Relative URLs only (Vite proxies /api /auth /public /__dev
// to the app in dev; same-origin in prod).

/** A failed API call. `code` is the server's machine-readable { error } value
 *  (e.g. 'forbidden', 'unauthorized') when present, else a synthetic code;
 *  `status` is the HTTP status (0 = network failure). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The parsed response body, when JSON (for endpoint-specific extra fields). */
  readonly body: unknown;
  /** The server's { detail } diagnostic string, when present (e.g. the library
   *  error behind a 400 transcode_failed) - structured access for UI copy. */
  readonly detail?: string;

  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    if (body !== null && typeof body === 'object') {
      const d = (body as Record<string, unknown>)['detail'];
      if (typeof d === 'string') this.detail = d;
    }
  }
}

type Json = Record<string, unknown>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON body — serialized + Content-Type set automatically. */
  body?: unknown;
  /** Query params; undefined/null values are dropped. */
  query?: Record<string, string | number | null | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Best-effort parse of a JSON body; undefined when there's no JSON to parse. */
async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return undefined;
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Pull the server's { error } code + a human message out of an error body. */
function errorFrom(status: number, body: unknown): ApiError {
  if (body !== null && typeof body === 'object') {
    const b = body as Json;
    const code = typeof b['error'] === 'string' ? b['error'] : `http_${status}`;
    const detail = typeof b['detail'] === 'string' ? ` (${b['detail']})` : '';
    return new ApiError(status, code, `${code}${detail}`, body);
  }
  return new ApiError(status, `http_${status}`, `Request failed (${status})`, body);
}

/**
 * Core request. Returns the parsed JSON body typed as T (use `void`/`undefined`
 * for 204 endpoints). Throws ApiError on non-2xx or network failure.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      credentials: 'same-origin',
      ...(payload !== undefined && { body: payload }),
      ...(signal !== undefined && { signal }),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Network request failed');
  }

  const parsed = await parseBody(res);
  if (!res.ok) {
    throw errorFrom(res.status, parsed);
  }
  return parsed as T;
}
