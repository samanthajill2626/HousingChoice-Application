// How does Windows hand out ephemeral ports to these loopback connects?
// Orders every client-side endpoint toward the watched service ports by first
// sight and looks at consecutive local-port deltas.
import fs from 'node:fs';
const [, , conns, ...svcPorts] = process.argv;
const svc = new Set(svcPorts.map(Number));
const lines = fs.readFileSync(conns, 'utf8').split(/\r?\n/).filter(Boolean);
const hdr = lines.shift().split('\t');
const rows = lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [hdr[i], Number(v)])));
const cli = rows.filter((r) => svc.has(r.rport) && r.lport >= 49152).sort((a, b) => a.firstMs - b.firstMs);
const deltas = new Map();
let seq = 0;
for (let i = 1; i < cli.length; i++) {
  const d = cli[i].lport - cli[i - 1].lport;
  const b = d === 1 ? '+1' : d > 1 && d <= 10 ? '+2..10' : d > 10 && d <= 200 ? '+11..200' : d < 0 && d >= -10 ? '-1..-10' : 'other';
  deltas.set(b, (deltas.get(b) ?? 0) + 1);
  if (d > 0 && d <= 10) seq++;
}
const ports = cli.map((r) => r.lport);
console.log(JSON.stringify({ clientEndpoints: cli.length, minPort: Math.min(...ports), maxPort: Math.max(...ports), distinctPorts: new Set(ports).size, deltaBuckets: Object.fromEntries(deltas), shareSmallForwardStep: (seq / (cli.length - 1)).toFixed(3) }));
console.log('first 30 ports in order:', cli.slice(0, 30).map((r) => r.lport).join(' '));
