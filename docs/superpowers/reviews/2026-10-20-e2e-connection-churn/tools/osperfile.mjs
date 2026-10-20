// OS-level (hook-agnostic) connections per spec file: every client-side or
// server-side endpoint toward the Vite or app port, de-duplicated to one per
// connection, attributed to the test whose window contains its first sight.
// Lets a hook-free run be compared with a hooked one.
// usage: node osperfile.mjs <runDir> <vitePort> <appPort>
import fs from 'node:fs';
import path from 'node:path';

const [, , runDir, vS, aS] = process.argv;
const vite = Number(vS), app = Number(aS);
const series = fs.readFileSync(path.join(runDir, 'sampler', 'series.tsv'), 'utf8');
const epoch = Number(series.match(/#epochStartMs=(\d+)/)[1]);
const lines = fs.readFileSync(path.join(runDir, 'sampler', 'conns.tsv'), 'utf8').split(/\r?\n/).filter(Boolean);
const hdr = lines.shift().split('\t');
const rows = lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [hdr[i], Number(v)])));
// one record per connection: keep the client endpoint if seen, else the server one
const conns = new Map();
for (const r of rows) {
  let key, svc;
  if (r.rport === vite || r.rport === app) { key = `${r.lport}>${r.rport}`; svc = r.rport; }
  else if (r.lport === vite || r.lport === app) { key = `${r.rport}>${r.lport}`; svc = r.lport; }
  else continue;
  const t = epoch + r.firstMs;
  const prev = conns.get(key);
  // a reused tuple more than 5 s apart is a different connection
  if (prev && Math.abs(prev.at(-1).t - t) < 5000) continue;
  if (!prev) conns.set(key, []);
  conns.get(key).push({ t, svc });
}
const flat = [...conns.values()].flat().sort((a, b) => a.t - b.t);
const res = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8'));
const tests = [];
const walk = (s) => {
  for (const sp of s.specs ?? []) for (const t of sp.tests) for (const r of t.results) tests.push({ file: sp.file.replace(/\\/g, '/').split('/').slice(-2).join('/'), start: Date.parse(r.startTime), end: Date.parse(r.startTime) + r.duration, status: r.status });
  for (const c of s.suites ?? []) walk(c);
};
for (const s of res.suites) walk(s);
const per = new Map();
for (const t of tests) {
  let v = 0, a = 0;
  for (const c of flat) { if (c.t < t.start) continue; if (c.t >= t.end) break; if (c.svc === vite) v++; else a++; }
  if (!per.has(t.file)) per.set(t.file, { tests: 0, v: 0, a: 0, ms: 0, failed: 0 });
  const g = per.get(t.file);
  g.tests++; g.v += v; g.a += a; g.ms += t.end - t.start; if (t.status !== 'passed') g.failed++;
}
console.log('file | tests | failed | browser->vite per test | vite->app per test | s per test');
for (const [f, g] of [...per].sort()) console.log(`${f} | ${g.tests} | ${g.failed} | ${(g.v / g.tests).toFixed(0)} | ${(g.a / g.tests).toFixed(0)} | ${(g.ms / g.tests / 1000).toFixed(1)}`);
const peak = series.split(/\r?\n/).filter((l) => /^\d/.test(l)).reduce((m, l) => Math.max(m, Number(l.split('\t')[3])), 0);
console.log(`peak machine TIME_WAIT: ${peak}; connections toward vite/app in run: ${flat.length}`);
