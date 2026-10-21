import fs from 'node:fs';
import path from 'node:path';
const hdir = path.join(process.argv[2], 'hook');
const from = Number(process.argv[3] ?? 0), to = Number(process.argv[4] ?? Infinity), vitePort = Number(process.argv[5] ?? 9411);
let L = null;
for (const f of fs.readdirSync(hdir)) {
  const recs = fs.readFileSync(path.join(hdir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (recs.some((r) => r.e === 'ic' && r.lp === vitePort)) L = recs;
}
const rq = new Map();
for (const r of L) {
  if (r.t < from || r.t > to) continue;
  if (r.e === 'rq' && r.p.startsWith('/api/events')) rq.set(r.id + ':' + r.i, { t: r.t });
  if (r.e === 'rqc') { const o = rq.get(r.id + ':' + r.i); if (o) { o.end = r.t; o.done = r.done; } }
}
const b = { '<50ms': 0, '50ms-1s': 0, '1-10s': 0, '>10s': 0, 'still open': 0 };
for (const o of rq.values()) {
  if (o.end === undefined) { b['still open']++; continue; }
  const d = o.end - o.t;
  b[d < 50 ? '<50ms' : d < 1000 ? '50ms-1s' : d < 10000 ? '1-10s' : '>10s']++;
}
console.log(JSON.stringify({ sseStreams: rq.size, lifetime: b }));
