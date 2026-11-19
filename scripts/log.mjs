#!/usr/bin/env node
// rag-first's gate decisions as a compact table.
//   node scripts/log.mjs              the last 20 decisions
//   node scripts/log.mjs 50           the last 50 (also -n 50)
//   node scripts/log.mjs --watch      the last 20, then each new decision as it happens (Ctrl-C to stop)
//   node scripts/log.mjs --session ID only that session's (a prefix is enough)
//   node scripts/log.mjs --summary    counts per decision (and per project) over the whole log
//   node scripts/log.mjs --json       the raw log lines
// Reads ~/.claude/rag-first/gate.jsonl (or $RAG_FIRST_DIR/gate.jsonl).
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, watchFile } from 'node:fs';
import { join } from 'node:path';
import { dataDir, makeIO } from './lib.mjs';

const argv = process.argv.slice(2);
let n = 20, watch = false, session, json = false, summary = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-n') n = parseInt(argv[++i], 10);
  else if (a === '--watch' || a === '-f') watch = true;
  else if (a === '--session') session = argv[++i];
  else if (a === '--json') json = true;
  else if (a === '--summary') summary = true;
  else if (/^\d+$/.test(a)) n = parseInt(a, 10);
}
if (!Number.isFinite(n) || n < 1) n = 20;

const FILE = join(dataDir(makeIO()), 'gate.jsonl');
const parse = (text) => text.split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((e) => e && (!session || String(e.session_id || '').startsWith(session)));

const COLS = [['time', 8], ['session', 8], ['event', 16], ['tool', 26], ['decision', 13], ['project', 14], ['detail', 56]];
const fit = (s, w) => { s = String(s ?? ''); return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w); };
const hhmmss = (ts) => { const d = new Date(ts); return Number.isNaN(+d) ? '' : d.toTimeString().slice(0, 8); };
const row = (e) => ({
  time: hhmmss(e.ts), session: String(e.session_id || '').slice(0, 8), event: e.event || '', tool: e.tool || '',
  decision: e.decision || '', project: e.project_id || '',
  detail: [e.n ? `#${e.n}` : '', e.reason || '', e.detail || ''].filter(Boolean).join(' · '),
});
const line = (r) => COLS.map(([k, w]) => fit(r[k], w)).join('  ').trimEnd();
const header = () => line(Object.fromEntries(COLS.map(([k]) => [k, k]))) + '\n' + COLS.map(([, w]) => '─'.repeat(w)).join('  ');
const print = (e) => console.log(json ? JSON.stringify(e) : line(row(e)));

const all = existsSync(FILE) ? parse(readFileSync(FILE, 'utf8')) : [];
if (summary) {
  const by = {}, prompts = new Set(), denied = new Set(), searchedPrompts = new Set();
  let prompt = {};
  for (const e of all) {
    by[e.decision] = (by[e.decision] || 0) + 1;
    if (e.decision === 'reset') { prompt[e.session_id] = (prompt[e.session_id] || 0) + 1; if (e.project_id) prompts.add(`${e.session_id}:${prompt[e.session_id]}`); }
    const key = `${e.session_id}:${prompt[e.session_id] || 0}`;
    if (e.decision === 'deny') denied.add(key);
    if (e.decision === 'searched') searchedPrompts.add(key);
  }
  console.log(`decisions in ${FILE}${session ? ` (session ${session}…)` : ''}:`);
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}`);
  console.log(`prompts in indexed projects: ${prompts.size} · with a RAG search: ${[...prompts].filter((p) => searchedPrompts.has(p)).length} · with a denial: ${[...prompts].filter((p) => denied.has(p)).length}`);
  process.exit(0);
}
if (!json) {
  if (!all.length && !watch) {
    console.log(`no decisions yet in ${FILE}${session ? ` for session ${session}` : ''}`);
    process.exit(0);
  }
  console.log(header());
}
all.slice(-n).forEach(print);
if (!json && !watch && all.length) console.log(`(${Math.min(n, all.length)} of ${all.length}, from ${FILE})`);

if (watch) {
  if (!json) console.error(`watching ${FILE} (Ctrl-C to stop)`);
  let offset = existsSync(FILE) ? statSync(FILE).size : 0;
  let partial = '';
  watchFile(FILE, { interval: 500 }, (cur) => {
    if (cur.size < offset) offset = 0;
    if (cur.size === offset) return;
    const fd = openSync(FILE, 'r');
    const buf = Buffer.alloc(cur.size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    offset = cur.size;
    const text = partial + buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    partial = text.slice(cut + 1);
    parse(text.slice(0, cut + 1)).forEach(print);
  });
}
