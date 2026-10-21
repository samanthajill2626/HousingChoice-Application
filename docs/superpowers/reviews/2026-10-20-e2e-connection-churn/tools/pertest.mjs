// Per-run and per-spec-file churn from the hook: connections the browser opened
// to Vite, connections Vite opened to the app, proxied requests Vite tore down
// unfinished, split by cause:
//   strict   - unfinished < 50 ms AND the same URL requested again within 100 ms
//              (React StrictMode's double mount; proven by abort stacks)
//   sse      - GET /api/events (one stream per page load, cut at navigation)
//   other    - any other unfinished proxied request (navigation mid-load)
// usage: node pertest.mjs <runDir> <vitePort> <appPort>
import fs from 'node:fs';
import path from 'node:path';

const [, , runDir, vitePortS, appPortS] = process.argv;
const vitePort = Number(vitePortS), appPort = Number(appPortS);
const hdir = path.join(runDir, 'hook');
let V = null;
for (const f of fs.readdirSync(hdir)) {
  const recs = fs.readFileSync(path.join(hdir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (recs.some((r) => r.e === 'ic' && r.lp === vitePort)) V = (V ?? []).concat(recs);
}
const res = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8'));
const tests = [];
const walk = (s) => {
  for (const sp of s.specs ?? []) for (const t of sp.tests) for (const r of t.results) tests.push({ file: sp.file.replace(/\\/g, '/'), title: sp.title, start: Date.parse(r.startTime), end: Date.parse(r.startTime) + r.duration, status: r.status });
  for (const c of s.suites ?? []) walk(c);
};
for (const s of res.suites) walk(s);
tests.sort((a, b) => a.start - b.start);

const reqs = [];
const byKey = new Map();
const inConns = [], outConns = [];
for (const r of V) {
  if (r.e === 'ic' && r.lp === vitePort) inConns.push(r.t);
  if (r.e === 'oc' && r.rp === appPort) outConns.push(r.t);
  if (r.e === 'rq') { const o = { t: r.t, p: r.p, m: r.m }; byKey.set(r.id + ':' + r.i, o); reqs.push(o); }
  if (r.e === 'rqc') { const o = byKey.get(r.id + ':' + r.i); if (o) { o.end = r.t; o.done = r.done; } }
}
reqs.sort((a, b) => a.t - b.t);
// index for the "same URL again within 100 ms" test
const byPath = new Map();
for (const o of reqs) { if (!byPath.has(o.p)) byPath.set(o.p, []); byPath.get(o.p).push(o.t); }
const refetched = (o) => byPath.get(o.p).some((t) => t > o.t && t - o.t < 100);
for (const o of reqs) {
  if (o.done !== 0) { o.cause = null; continue; }
  o.cause = o.p.startsWith('/api/events') ? 'sse' : o.end - o.t < 50 && refetched(o) ? 'strict' : 'other';
}

const count = (arr, a, b) => { let n = 0; for (const t of arr) if (t >= a && t < b) n++; return n; };
const perFile = new Map();
const total = { tests: 0, inConns: 0, outConns: 0, proxied: 0, strict: 0, sse: 0, other: 0 };
let ri = 0;
for (const t of tests) {
  const row = { inConns: count(inConns, t.start, t.end), outConns: count(outConns, t.start, t.end), proxied: 0, strict: 0, sse: 0, other: 0 };
  for (const o of reqs) {
    if (o.t < t.start || o.t >= t.end) continue;
    row.proxied++;
    if (o.cause) row[o.cause]++;
  }
  const f = t.file.split('/').slice(-2).join('/');
  if (!perFile.has(f)) perFile.set(f, { tests: 0, inConns: 0, outConns: 0, proxied: 0, strict: 0, sse: 0, other: 0, ms: 0 });
  const g = perFile.get(f);
  g.tests++; g.ms += t.end - t.start;
  for (const k of ['inConns', 'outConns', 'proxied', 'strict', 'sse', 'other']) { g[k] += row[k]; total[k] += row[k]; }
  total.tests++;
}
// whole-run (including between-test gaps and boot)
const allUnfinished = reqs.filter((o) => o.cause);
const whole = {
  browserToViteConns: inConns.length,
  viteToAppConns: outConns.length,
  proxiedRequests: reqs.length,
  unfinishedProxied: allUnfinished.length,
  strict: allUnfinished.filter((o) => o.cause === 'strict').length,
  sse: allUnfinished.filter((o) => o.cause === 'sse').length,
  other: allUnfinished.filter((o) => o.cause === 'other').length,
};
console.log('WHOLE RUN', JSON.stringify(whole));
console.log('INSIDE TEST WINDOWS', JSON.stringify(total));
const strictPaths = new Map();
for (const o of allUnfinished.filter((x) => x.cause === 'strict')) {
  const k = o.m + ' ' + o.p.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').replace(/\/(contact|unit|placement|tour|conv|user|org|bc|msg)-[A-Za-z0-9_-]+/g, '/$1-:id').replace(/\?$/, '?...');
  strictPaths.set(k, (strictPaths.get(k) ?? 0) + 1);
}
console.log('TOP STRICT-MODE ABORTED PATHS');
for (const [k, n] of [...strictPaths].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${n} ${k}`);
console.log('PER FILE (sorted by browser->Vite + Vite->app connections)');
console.log('file | tests | s | browser->vite conns | vite->app conns | conns/test | unfinished: strict / sse / other');
for (const [f, g] of [...perFile].sort((a, b) => (b[1].inConns + b[1].outConns) - (a[1].inConns + a[1].outConns)).slice(0, 25)) {
  console.log(`${f} | ${g.tests} | ${(g.ms / 1000).toFixed(0)} | ${g.inConns} | ${g.outConns} | ${((g.inConns + g.outConns) / g.tests).toFixed(0)} | ${g.strict} / ${g.sse} / ${g.other}`);
}
