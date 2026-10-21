// Attributes each browser TCP connect in a Chromium NetLog to the request that
// first used the new socket, and counts how many requests each socket carried.
// The chain is socket (TCP_CONNECT) <- stream job (SOCKET_POOL_BOUND_TO_SOCKET)
// -> URL request (HTTP_STREAM_JOB_BOUND_TO_REQUEST) -> URL_REQUEST_START_JOB url.
// Approximate by construction: a connect job opened for one request can be
// handed to another, so "first user" is the request that got the socket.
// usage: node netlog-connects.mjs <netlog.json>
import fs from 'node:fs';
import readline from 'node:readline';

const file = process.argv[2];
let header = '';
let inEvents = false;
const typeName = new Map();
const connected = new Set(); // socket ids that ran TCP_CONNECT
const socketJobs = new Map(); // socket id -> [job ids in bind order]
const jobRequest = new Map(); // job id -> url request id
const requestUrl = new Map(); // url request id -> { url, method }
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!inEvents) {
    header += line;
    const i = header.indexOf('"events": [');
    const k = i >= 0 ? i : header.indexOf('"events":[');
    if (k >= 0) {
      const c = JSON.parse(header.slice(header.indexOf('{') + 1, k).trim().replace(/^"constants":\s*/, '').replace(/,\s*$/, ''));
      for (const [n, v] of Object.entries(c.logEventTypes)) typeName.set(v, n);
      inEvents = true;
    }
    continue;
  }
  const s = line.trim().replace(/,$/, '');
  if (!s.startsWith('{')) continue;
  let ev;
  try { ev = JSON.parse(s); } catch { continue; }
  const name = typeName.get(ev.type);
  const id = ev.source?.id;
  const dep = ev.params?.source_dependency?.id;
  if (name === 'TCP_CONNECT' && ev.phase === 1) connected.add(id);
  else if (name === 'SOCKET_POOL_BOUND_TO_SOCKET' && dep !== undefined) {
    const list = socketJobs.get(dep) ?? [];
    list.push(id);
    socketJobs.set(dep, list);
  } else if (name === 'HTTP_STREAM_JOB_BOUND_TO_REQUEST' && dep !== undefined) {
    if (!jobRequest.has(id)) jobRequest.set(id, dep);
  } else if (name === 'URL_REQUEST_START_JOB' && ev.phase === 1 && !requestUrl.has(id)) {
    requestUrl.set(id, { url: String(ev.params?.url ?? ''), method: String(ev.params?.method ?? '') });
  }
}

function classify(url) {
  let u;
  try { u = new URL(url); } catch { return 'unknown'; }
  const p = u.pathname;
  if (u.protocol.startsWith('ws')) return 'websocket';
  if (p === '/api/events') return 'SSE /api/events';
  if (/^\/(api|auth|__dev|app-identity|unit-media|public)(\/|$)/.test(p)) return `proxied ${p.split('/')[1]}`;
  if (p.startsWith('/assets/')) return 'built asset';
  if (p.startsWith('/@') || p.startsWith('/src/') || p.startsWith('/node_modules/')) return 'dev module';
  if (/\.(js|css|png|svg|ico|webmanifest)$/.test(p)) return 'static file';
  return 'document';
}

const byClass = new Map();
const perSocket = new Map(); // requests carried -> sockets
let unattributed = 0;
for (const sock of connected) {
  const jobs = socketJobs.get(sock) ?? [];
  const reqs = jobs.map((j) => jobRequest.get(j)).filter((r) => r !== undefined);
  const n = reqs.length;
  perSocket.set(n, (perSocket.get(n) ?? 0) + 1);
  const first = reqs.length > 0 ? requestUrl.get(reqs[0]) : undefined;
  if (!first) { unattributed += 1; continue; }
  const c = classify(first.url);
  const row = byClass.get(c) ?? { connects: 0, single: 0 };
  row.connects += 1;
  if (n === 1) row.single += 1;
  byClass.set(c, row);
}
console.log(`TCP connects: ${connected.size} (no request bound: ${unattributed})`);
console.log('first request on the new socket | connects | of which carried only that one request');
for (const [c, r] of [...byClass].sort((a, b) => b[1].connects - a[1].connects)) {
  console.log(`${c} | ${r.connects} | ${r.single}`);
}
console.log('requests per socket | sockets');
for (const [n, k] of [...perSocket].sort((a, b) => a[0] - b[0])) console.log(`${n} | ${k}`);
