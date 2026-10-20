// Peak TIME_WAIT over a run window three ways: the whole machine, all
// loopback, and only the tuples on the lane's own ports plus DynamoDB Local
// (8000) and MinIO (9000). The lane figure is the one a busy neighbour on the
// machine cannot inflate, so it is the fair before/after comparison.
// usage: node lanepeak.mjs <runDir> <laneJson>
// (window = run.start .. run.end from <runDir>, padded by the 120 s TIME_WAIT)
import fs from 'node:fs';
import path from 'node:path';

const [, , runDir, laneFile] = process.argv;
const lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
const ports = [...Object.values(lane.ports), 8000, 9000];
const lines = fs.readFileSync(path.join(runDir, 'sampler', 'series.tsv'), 'utf8').split(/\r?\n/);
const hdr = lines[0].split('\t');
const col = (name) => hdr.indexOf(name);
const laneCols = ports.flatMap((p) => [col(`srvTW_${p}`), col(`cliTW_${p}`)]).filter((i) => i >= 0);
const readMs = (f) => Number(fs.readFileSync(path.join(runDir, f), 'utf8').trim());
const from = readMs('run.start');
const to = readMs('run.end') + 120_000;

let first = null;
const peak = { all: [0, 0], loop: [0, 0], lane: [0, 0] };
for (const line of lines.slice(1)) {
  if (!line || line.startsWith('#')) continue;
  const f = line.split('\t');
  const t = Number(f[col('epochMs')]);
  if (t < from || t > to) continue;
  const all = Number(f[col('allTW')]);
  const loop = Number(f[col('loopTW')]);
  const ln = laneCols.reduce((s, i) => s + Number(f[i]), 0);
  if (first === null) first = { all, loop, lane: ln };
  for (const [k, v] of [['all', all], ['loop', loop], ['lane', ln]]) {
    if (v > peak[k][0]) peak[k] = [v, t];
  }
}
const at = (t) => `${((t - from) / 60000).toFixed(1)} min in`;
console.log(`ports: ${ports.join(',')}; window ${((to - from) / 60000).toFixed(1)} min`);
console.log(`at start   - machine ${first?.all}, loopback ${first?.loop}, lane ${first?.lane}`);
console.log(`peak       - machine ${peak.all[0]} (${at(peak.all[1])}), loopback ${peak.loop[0]} (${at(peak.loop[1])}), lane ${peak.lane[0]} (${at(peak.lane[1])})`);
