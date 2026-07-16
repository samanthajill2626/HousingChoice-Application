#!/usr/bin/env node
// Live mirror for a background agent transcript (Claude Code task .output
// JSONL) -> a human-readable, append-only log the human keeps open in the
// editor. Usage: node transcript-tail.mjs <transcript.jsonl> <live.log>
// Polls every 2s; safe against partial trailing lines; never truncates dst.
import fs from 'node:fs';

const [, , src, dst] = process.argv;
if (!src || !dst) {
  console.error('usage: node transcript-tail.mjs <transcript.jsonl> <live.log>');
  process.exit(2);
}

let pos = 0;
let rem = '';

const trunc = (s, n) => {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + ' ...' : s;
};

function renderLine(line) {
  let j;
  try { j = JSON.parse(line); } catch { return ''; }
  const ts = (j.timestamp || '').slice(11, 19);
  const out = [];
  const c = j.message && j.message.content;
  const role = (j.message && j.message.role || j.type || '?').toUpperCase();
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text' && b.text && b.text.trim()) {
        out.push(`[${ts}] ${role}> ${b.text.trim()}`);
      } else if (b.type === 'tool_use') {
        const i = b.input || {};
        const hint = i.description || i.command || i.prompt || i.file_path || '';
        out.push(`[${ts}] TOOL> ${b.name}${hint ? ': ' + trunc(hint, 160) : ''}`);
      } else if (b.type === 'tool_result') {
        const parts = Array.isArray(b.content)
          ? b.content.map(p => p.text || '').join(' ')
          : (b.content || '');
        if (String(parts).trim()) out.push(`[${ts}] RESULT> ${trunc(parts, 200)}`);
      }
    }
  } else if (typeof c === 'string' && c.trim()) {
    out.push(`[${ts}] ${role}> ${trunc(c, 400)}`);
  }
  return out.join('\n');
}

function tick() {
  let st;
  try { st = fs.statSync(src); } catch { return; }
  if (st.size < pos) { pos = 0; rem = ''; } // rotated/replaced
  if (st.size === pos) return;
  const fd = fs.openSync(src, 'r');
  const buf = Buffer.alloc(st.size - pos);
  fs.readSync(fd, buf, 0, buf.length, pos);
  fs.closeSync(fd);
  pos = st.size;
  const chunk = rem + buf.toString('utf8');
  const lines = chunk.split('\n');
  rem = lines.pop() || '';
  const rendered = lines.map(renderLine).filter(Boolean).join('\n');
  if (rendered) fs.appendFileSync(dst, rendered + '\n');
}

fs.appendFileSync(dst, `=== transcript mirror started ${new Date().toISOString()} ===\n`);
setInterval(tick, 2000);
tick();
