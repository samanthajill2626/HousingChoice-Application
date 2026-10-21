// What one process's hook saw in a time window: accepted connections and every
// request, in order, with whether its response finished.
import fs from 'node:fs';
import path from 'node:path';
const [, , runDir, portS, fromS, toS] = process.argv;
const port = Number(portS), from = Number(fromS), to = Number(toS);
const hdir = path.join(runDir, 'hook');
let L = [];
for (const f of fs.readdirSync(hdir)) {
  const recs = fs.readFileSync(path.join(hdir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (recs.some((r) => r.e === 'ic' && r.lp === port)) L = L.concat(recs);
}
const conns = new Map(), reqs = new Map();
for (const r of L) {
  if (r.e === 'ic' && r.lp === port) conns.set(r.id, { t: r.t, rp: r.rp, n: 0 });
  if (r.e === 'sr' && conns.has(r.id)) { conns.get(r.id).n++; reqs.set(r.id + ':' + r.i, { t: r.t, id: r.id, p: r.p, m: r.m }); }
  if (r.e === 'src') { const q = reqs.get(r.id + ':' + r.i); if (q) { q.end = r.t; q.done = r.done; q.s = r.s; } }
  if (r.e === 'x' && r.d === 'in' && conns.has(r.id)) conns.get(r.id).closed = r.t;
}
const inWin = [...reqs.values()].filter((q) => q.t >= from && q.t <= to).sort((a, b) => a.t - b.t);
const newConns = [...conns.values()].filter((c) => c.t >= from && c.t <= to);
console.log(`requests in window: ${inWin.length}; connections accepted in window: ${newConns.length}`);
const unfinished = inWin.filter((q) => q.done !== 1);
console.log(`unfinished/never-closed responses: ${unfinished.length}`);
for (const q of unfinished.slice(0, 20)) console.log(`  +${q.t - from}ms conn${q.id} ${q.m} ${q.p} status=${q.s} done=${q.done} end=${q.end ? '+' + (q.end - from) : 'none'}`);
const last = inWin.at(-1);
console.log(`first request: +${inWin[0]?.t - from}ms ${inWin[0]?.p}; last request: +${last?.t - from}ms ${last?.p}`);
const gaps = [];
for (let i = 1; i < inWin.length; i++) if (inWin[i].t - inWin[i - 1].t > 1500) gaps.push(`gap ${inWin[i].t - inWin[i - 1].t}ms after +${inWin[i - 1].t - from}ms ${inWin[i - 1].p} -> ${inWin[i].p}`);
console.log(gaps.slice(0, 10).join('\n'));
const html = inWin.filter((q) => !/\.(tsx?|jsx?|css|svg|png|woff2?|json)(\?|$)/.test(q.p) && !q.p.startsWith('/@') && !q.p.startsWith('/node_modules'));
console.log('non-module requests:', html.map((q) => `+${q.t - from} ${q.m} ${q.p} s=${q.s}`).join(' | '));
