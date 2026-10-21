// For NetLog sources that hit a given net error: print their events + URL/host.
import fs from 'node:fs';
import readline from 'node:readline';
const [, , file, errArg, maxS] = process.argv;
const want = Number(errArg);
const max = Number(maxS ?? 3);
let header = '', inEvents = false, typeName = new Map(), tickOffset = 0;
const bySource = new Map();
const hit = new Set();
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!inEvents) {
    header += line;
    const k = header.indexOf('"events":[') >= 0 ? header.indexOf('"events":[') : header.indexOf('"events": [');
    if (k >= 0) {
      const c = JSON.parse(header.slice(header.indexOf('{') + 1, k).trim().replace(/^"constants":\s*/, '').replace(/,\s*$/, ''));
      for (const [n, v] of Object.entries(c.logEventTypes)) typeName.set(v, n);
      tickOffset = Number(c.timeTickOffset ?? 0);
      inEvents = true;
    }
    continue;
  }
  const s = line.trim().replace(/,$/, '');
  if (!s.startsWith('{')) continue;
  let ev; try { ev = JSON.parse(s); } catch { continue; }
  const id = ev.source?.id;
  if (id === undefined) continue;
  // keep a short rolling history per source (url/host params arrive early)
  const list = bySource.get(id) ?? [];
  if (list.length < 40) list.push(ev);
  bySource.set(id, list);
  if (ev.params?.net_error === want) hit.add(id);
}
let n = 0;
for (const id of hit) {
  if (n++ >= max) break;
  console.log(`--- source ${id}`);
  for (const ev of bySource.get(id)) {
    const p = JSON.stringify(ev.params ?? {}).slice(0, 220);
    console.log(new Date(tickOffset + Number(ev.time)).toISOString(), typeName.get(ev.type), ev.phase, p);
  }
}
console.log(`sources with error ${want}: ${hit.size}`);
