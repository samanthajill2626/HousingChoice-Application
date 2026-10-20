// Streams a Chromium NetLog (one event per line after the constants block) and
// counts socket-level failures: every event carrying a net_error, grouped by
// event type and error, with the first few timestamps. Also counts TCP connect
// attempts so a failure RATE per connect can be stated.
import fs from 'node:fs';
import readline from 'node:readline';

const file = process.argv[2];
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
let constants = null;
let header = '';
let inEvents = false;
const typeName = new Map();
const errName = new Map();
const tally = new Map();
const samples = new Map();
let tcpConnectAttempts = 0;
let tickOffset = 0;
for await (const line of rl) {
  if (!inEvents) {
    header += line;
    const i = header.indexOf('"events": [');
    const j = header.indexOf('"events":[');
    const k = i >= 0 ? i : j;
    if (k >= 0) {
      const consStr = header.slice(header.indexOf('{') + 1, k).trim().replace(/^"constants":\s*/, '').replace(/,\s*$/, '');
      constants = JSON.parse(consStr);
      for (const [n, v] of Object.entries(constants.logEventTypes)) typeName.set(v, n);
      for (const [n, v] of Object.entries(constants.netError)) errName.set(v, n);
      tickOffset = Number(constants.timeTickOffset ?? 0);
      inEvents = true;
    }
    continue;
  }
  const s = line.trim().replace(/,$/, '');
  if (!s.startsWith('{')) continue;
  let ev;
  try { ev = JSON.parse(s); } catch { continue; }
  const tn = typeName.get(ev.type) ?? String(ev.type);
  if (tn === 'TCP_CONNECT_ATTEMPT' && ev.phase === 1) tcpConnectAttempts++;
  const ne = ev.params?.net_error ?? ev.params?.os_error;
  if (ne === undefined || ne === 0) continue;
  if (ne === -3) continue; // ERR_ABORTED: a cancelled request, counted elsewhere
  const key = `${tn} ${errName.get(ne) ?? ne}${ev.params?.os_error !== undefined ? ' os_error=' + ev.params.os_error : ''}`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
  if (!samples.has(key)) samples.set(key, []);
  if (samples.get(key).length < 5) samples.get(key).push(new Date(tickOffset + Number(ev.time)).toISOString());
}
console.log(`TCP connect attempts: ${tcpConnectAttempts}`);
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`${n}\t${k}\tfirst at ${samples.get(k).join(', ')}`);
