// For vite -> app requests that were destroyed unfinished: how long they lived
// and whether the same path was requested again right after (StrictMode remount
// signature) - versus aborted by a navigation / context close.
import fs from 'node:fs';
import path from 'node:path';
const hdir = path.join(process.argv[2], 'hook');
const from = Number(process.argv[3] ?? 0);
let viteRecs = null;
for (const f of fs.readdirSync(hdir)) {
  const L = fs.readFileSync(path.join(hdir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (L.some((r) => r.e === 'ic' && r.lp === Number(process.argv[4] ?? 9411))) viteRecs = L;
}
const rq = new Map(), all = [];
for (const r of viteRecs) {
  if (r.t < from) continue;
  if (r.e === 'rq') { const o = { ...r, key: r.id + ':' + r.i }; rq.set(o.key, o); all.push(o); }
  if (r.e === 'rqc') { const o = rq.get(r.id + ':' + r.i); if (o) { o.end = r.t; o.done = r.done; o.s = r.s; } }
}
all.sort((a, b) => a.t - b.t);
const aborted = all.filter((o) => o.done === 0);
const buckets = { '<10ms': 0, '10-50ms': 0, '50-250ms': 0, '250ms-1s': 0, '1-5s': 0, '>5s': 0 };
let refetched = 0;
const sse = aborted.filter((o) => o.p.startsWith('/api/events'));
for (const o of aborted) {
  if (o.p.startsWith('/api/events')) continue;
  const d = o.end - o.t;
  buckets[d < 10 ? '<10ms' : d < 50 ? '10-50ms' : d < 250 ? '50-250ms' : d < 1000 ? '250ms-1s' : d < 5000 ? '1-5s' : '>5s']++;
  if (all.some((x) => x !== o && x.p === o.p && x.t >= o.t && x.t - o.t < 100)) refetched++;
}
// cluster aborts in time: a navigation/context close cancels many at once
const times = aborted.map((o) => o.end).sort((a, b) => a - b);
let clusters = 0, inBig = 0, i = 0;
while (i < times.length) { let j = i; while (j + 1 < times.length && times[j + 1] - times[j] < 50) j++; clusters++; if (j - i + 1 >= 3) inBig += j - i + 1; i = j + 1; }
console.log(JSON.stringify({ proxiedRequests: all.length, aborted: aborted.length, sseAborted: sse.length, nonSseAbortedLifetime: buckets, sameUrlRequestedAgainWithin100ms: refetched, abortClusters50ms: clusters, abortsInClustersOf3plus: inBig }, null, 1));
