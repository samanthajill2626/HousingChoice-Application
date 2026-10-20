// Distinct loopback connections toward the Vite and app ports first seen in
// each [from,to] window (epoch ms), from the passive sampler.
// usage: node oswindow.mjs <samplerDir> <vitePort> <appPort> <name:from:to> ...
import fs from 'node:fs';
import path from 'node:path';

const [, , dir, vS, aS, ...wins] = process.argv;
const vite = Number(vS), app = Number(aS);
const epoch = Number(fs.readFileSync(path.join(dir, 'series.tsv'), 'utf8').match(/#epochStartMs=(\d+)/)[1]);
const lines = fs.readFileSync(path.join(dir, 'conns.tsv'), 'utf8').split(/\r?\n/).filter(Boolean);
const hdr = lines.shift().split('\t');
const rows = lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [hdr[i], Number(v)])));
const seen = new Map();
for (const r of rows) {
  let key, svc;
  if (r.rport === vite || r.rport === app) { key = `${r.lport}>${r.rport}`; svc = r.rport; }
  else if (r.lport === vite || r.lport === app) { key = `${r.rport}>${r.lport}`; svc = r.lport; }
  else continue;
  const t = epoch + r.firstMs;
  const list = seen.get(key) ?? [];
  if (list.some((x) => Math.abs(x.t - t) < 5000)) continue;
  list.push({ t, svc });
  seen.set(key, list);
}
const all = [...seen.values()].flat();
for (const w of wins) {
  const [name, f, t] = w.split(':');
  const inW = all.filter((c) => c.t >= Number(f) && c.t <= Number(t));
  console.log(`${name}: browser->vite ${inW.filter((c) => c.svc === vite).length}, vite->app ${inW.filter((c) => c.svc === app).length} (${((Number(t) - Number(f)) / 1000).toFixed(0)} s)`);
}
