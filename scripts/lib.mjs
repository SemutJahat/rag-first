// rag-first: the gate's logic, kept free of process I/O so tests can drive it with a stub filesystem and env.
// Everything that touches the outside world goes through `io` ({ fs, env, home, now }), see makeIO().
import * as nodefs from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, basename, sep, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The two enowx-rag tools that count as "searched the RAG".
export const SEARCH_TOOLS = ['mcp__enowx-rag__rag_retrieve_context', 'mcp__enowx-rag__rag_semantic_search'];
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const MODES = ['strict', 'nudge', 'off'];
export const DISPLAYS = ['all', 'changes', 'off'];
const ICON = '🔎';

export const DEFAULT_CONFIG = {
  mode: 'strict',                          // "strict": deny until searched · "nudge": allow, with a reminder · "off"
  gatedTools: ['Grep', 'Glob', 'Read', 'Bash'],
  display: 'all',                          // the line shown to the user: "all" | "changes" | "off"
  maxDenials: 3,                           // loop guard: after this many denials in one prompt, let calls through
  pinTools: true,                          // hooks module: load the two search tools up front (not behind ToolSearch)
  allowSearchTools: false,                 // approve the two read-only search tools without a permission prompt
  exemptPromptFiles: true,                 // Read/Grep/Glob of a path the user named in the prompt
  exemptWrittenFiles: true,                // Read of a file the model wrote or edited in this session
  exemptOutsideProject: true,              // targets outside the indexed project folder (/tmp, ~/.claude, ...)
  exemptNonText: true,                     // Read of images, PDFs, archives, media
  projects: {},                            // { "/abs/folder": "project_id" } for projects missing from project_dirs.json
  stateTtlDays: 7,
  logMaxBytes: 5_000_000,
};

const NON_TEXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.pdf',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.tar', '.mp3', '.mp4', '.mov', '.wav', '.m4a', '.webm', '.avi',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.sqlite', '.db', '.bin', '.exe', '.dylib', '.so', '.class', '.jar']);

// Bash commands that search or read files. `sed` counts only with -n (a print), `git` only as `git grep`.
const SEARCHERS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'git-grep', 'fd', 'find']);
const READERS = new Set(['cat', 'head', 'tail', 'bat', 'less', 'more', 'sed']);
const PATTERN_FIRST = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'git-grep', 'fd', 'sed']);

export function makeIO(over = {}) {
  return { fs: nodefs, env: process.env, home: homedir(), now: () => new Date(), ...over };
}

export function dataDir(io) {
  return io.env.RAG_FIRST_DIR || join(io.home, '.claude', 'rag-first');
}

function readJson(io, file) {
  try { return JSON.parse(io.fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

// Config: the plugin's config.json, then <dataDir>/config.json (survives reinstalls), then $RAG_FIRST_CONFIG.
// Later files win, key by key. Bad values fall back to the default; a broken file is ignored.
export function loadConfig(io) {
  let cfg = structuredClone(DEFAULT_CONFIG);
  const files = [join(PLUGIN_ROOT, 'config.json'), join(dataDir(io), 'config.json')];
  if (io.env.RAG_FIRST_CONFIG) files.push(io.env.RAG_FIRST_CONFIG);
  for (const f of files) {
    const c = readJson(io, f);
    if (c && typeof c === 'object') cfg = { ...cfg, ...c, projects: { ...cfg.projects, ...(c.projects || {}) } };
  }
  if (io.env.RAG_FIRST_MODE) cfg.mode = io.env.RAG_FIRST_MODE;
  if (!MODES.includes(cfg.mode)) cfg.mode = DEFAULT_CONFIG.mode;
  if (!DISPLAYS.includes(cfg.display)) cfg.display = DEFAULT_CONFIG.display;
  if (!Array.isArray(cfg.gatedTools)) cfg.gatedTools = DEFAULT_CONFIG.gatedTools;
  if (!Number.isInteger(cfg.maxDenials) || cfg.maxDenials < 0) cfg.maxDenials = DEFAULT_CONFIG.maxDenials;
  return cfg;
}

// ---- paths ---------------------------------------------------------------------------------------

function real(io, p) {
  try { return io.fs.realpathSync(p); } catch { return resolve(p); }
}

export function isInside(child, parent) {
  if (!child || !parent) return false;
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function expandHome(io, p) {
  return p === '~' ? io.home : p.startsWith('~/') ? join(io.home, p.slice(2)) : p;
}

function absPath(io, p, cwd) {
  const e = expandHome(io, String(p));
  return isAbsolute(e) ? resolve(e) : resolve(cwd, e);
}

// Folders that are never a code project, even inside a git repo (a dotfiles repo in ~, for instance).
export function nonProjectDirs(io) {
  const h = io.home;
  return [h, join(h, 'Desktop'), join(h, 'Downloads'), join(h, 'Documents')].map((d) => resolve(d));
}

export function gitRoot(io, cwd) {
  let d = resolve(cwd);
  for (;;) {
    if (io.fs.existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

// The project-id rule of ~/.claude/CLAUDE.md: the lowercased git-root folder name, or <parent>-<folder>.
export function projectIdCandidates(root) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '-');
  const name = norm(basename(root));
  const parent = basename(dirname(root));
  return parent ? [name, `${norm(parent)}-${name}`] : [name];
}

// The enowx-rag project whose indexed folder holds cwd (longest match), from config "projects" and
// ~/.enowx-rag/project_dirs.json (written by rag_index_project). Undefined when none does.
export function findIndexedProject(io, cwd, cfg) {
  const entries = [];
  for (const [dir, id] of Object.entries(cfg.projects || {})) entries.push([id, [dir]]);
  const reg = readJson(io, join(io.home, '.enowx-rag', 'project_dirs.json'));
  if (reg && typeof reg === 'object') for (const [id, dirs] of Object.entries(reg)) if (Array.isArray(dirs)) entries.push([id, dirs]);
  const here = [resolve(cwd), real(io, cwd)];
  let best;
  for (const [id, dirs] of entries) {
    for (const raw of dirs) {
      if (typeof raw !== 'string' || !raw) continue;
      const dir = resolve(expandHome(io, raw));
      for (const d of new Set([dir, real(io, dir)])) {
        if (here.some((h) => isInside(h, d)) && (!best || d.length > best.dir.length)) best = { id, dir: d };
      }
    }
  }
  return best;
}

// Is the gate on for this folder? { active: true, id, root } or { active: false, reason }.
export function projectStatus(io, cwd, cfg) {
  if (io.env.ENOWX_SESSION) return { active: false, reason: 'enowX session (it has its own RAG)', quiet: true };
  if (!cwd) return { active: false, reason: 'no working folder' };
  const skip = nonProjectDirs(io);
  const c = resolve(cwd);
  if (skip.includes(c) || skip.includes(real(io, c))) return { active: false, reason: 'not a code project (home, Desktop, Downloads or Documents)', quiet: true };
  const hit = findIndexedProject(io, c, cfg);
  if (hit) {
    if (skip.includes(hit.dir)) return { active: false, reason: 'not a code project (indexed folder is home, Desktop, Downloads or Documents)', quiet: true };
    return { active: true, id: hit.id, root: hit.dir };
  }
  const root = gitRoot(io, c);
  if (!root || skip.includes(root)) return { active: false, reason: 'not a code project (no git root)', quiet: true };
  return { active: false, reason: `project not indexed in enowx-rag (would be project_id "${projectIdCandidates(root)[0]}")` };
}

// ---- is the enowx-rag MCP server in this session? ---------------------------------------------------

function claudeJsonPath(io) {
  return io.env.CLAUDE_CONFIG_DIR ? join(io.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(io.home, '.claude.json');
}

// Configured anywhere Claude Code reads MCP servers from for this folder (user, local, project scope).
export function mcpConfigured(io, cwd, root) {
  const has = (o) => !!(o && typeof o === 'object' && o.mcpServers && o.mcpServers['enowx-rag']);
  const cj = readJson(io, claudeJsonPath(io));
  if (has(cj)) return true;
  if (cj?.projects) for (const p of new Set([cwd, root].filter(Boolean))) if (has(cj.projects[p])) return true;
  if (root && has(readJson(io, join(root, '.mcp.json')))) return true;
  return false;
}

// Read a transcript from `offset`, only whole lines. Returns { text, end }.
function readFrom(io, file, offset) {
  const st = io.fs.statSync(file);
  if (st.size < offset) offset = 0;                     // replaced or truncated
  if (st.size === offset) return { text: '', end: offset };
  const fd = io.fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - offset);
    io.fs.readSync(fd, buf, 0, buf.length, offset);
    const s = buf.toString('utf8');
    const cut = s.lastIndexOf('\n');
    if (cut < 0) return { text: '', end: offset };
    return { text: s.slice(0, cut + 1), end: offset + Buffer.byteLength(s.slice(0, cut + 1)) };
  } finally { io.fs.closeSync(fd); }
}

// The session's own record of its tools: Claude Code writes `deferred_tools_delta` (names behind ToolSearch)
// and `mcp_instructions_delta` (MCP servers with instructions; enowx-rag has some) into the transcript before
// the model's first request. Scanned incrementally; the scan's progress lives in state.tscan.
export function scanTranscript(io, file, scan = {}) {
  const s = { offset: 0, saw: false, tools: [], servers: [], ...scan };
  const { text, end } = readFrom(io, file, s.offset);
  const tools = new Set(s.tools), servers = new Set(s.servers);
  for (const line of text.split('\n')) {
    if (!line.includes('_delta"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const a = d?.attachment;
    if (!a || typeof a !== 'object') continue;
    const add = Array.isArray(a.addedNames) ? a.addedNames : [];
    const rem = Array.isArray(a.removedNames) ? a.removedNames : [];
    if (a.type === 'deferred_tools_delta') {
      s.saw = true;
      for (const n of add) if (String(n).startsWith('mcp__enowx-rag__')) tools.add(n);
      for (const n of rem) tools.delete(n);
    } else if (a.type === 'mcp_instructions_delta') {
      s.saw = true;
      for (const n of add) if (n === 'enowx-rag') servers.add(n);
      for (const n of rem) servers.delete(n);
    }
  }
  return { ...s, offset: end, tools: [...tools], servers: [...servers] };
}

// { ok: true, via } or { ok: false, reason }. A positive answer is cached in state for the session.
export function mcpStatus(io, input, state, cwd, root) {
  if (state.mcp === true) return { ok: true, via: 'cached' };
  const sid = input.session_id;
  if (sid && io.fs.existsSync(join(dataDir(io), 'state', `${safeId(sid)}.mcp`))) { state.mcp = true; return { ok: true, via: 'module' }; }
  const t = input.transcript_path;
  if (t && io.fs.existsSync(t)) {
    try {
      state.tscan = scanTranscript(io, t, state.tscan);
      if (state.tscan.tools.length || state.tscan.servers.length) { state.mcp = true; return { ok: true, via: 'transcript' }; }
      if (state.tscan.saw) return { ok: false, reason: 'enowx-rag MCP server not loaded in this session' };
    } catch { /* fall through to the config files */ }
  }
  if (mcpConfigured(io, cwd, root)) return { ok: true, via: 'config' };
  return { ok: false, reason: 'enowx-rag MCP server not configured' };
}

// ---- what a tool call targets ---------------------------------------------------------------------

// A small shell splitter: words with quotes honoured, and the operators ; && || | & and newlines as their own tokens.
export function shellTokens(cmd) {
  const out = [];
  let cur = '', q = null, has = false;
  const push = () => { if (has) out.push(cur); cur = ''; has = false; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (ch === ' ' || ch === '\t') { push(); continue; }
    if (ch === '\n' || ch === ';') { push(); out.push({ op: ';' }); continue; }
    if (ch === '&' || ch === '|') {
      push();
      const two = cmd[i + 1] === ch;
      if (two) i++;
      out.push({ op: two ? (ch === '&' ? '&&' : '||') : ch });
      continue;
    }
    if (ch === '>' || ch === '<') {
      // a file-descriptor number right before it belongs to the operator: 2>/dev/null, 2>&1
      let op = ch;
      if (has && /^\d+$/.test(cur)) { op = cur + ch; cur = ''; has = false; } else push();
      while (cmd[i + 1] === '>' || cmd[i + 1] === '<' || cmd[i + 1] === '&') op += cmd[++i];
      out.push({ op });
      continue;
    }
    cur += ch; has = true;
  }
  push();
  return out;
}

// Does this command send its standard output to a file? `2>/dev/null`, `2>&1`, `> /dev/null` don't count.
function writesFile(seg) {
  for (let i = 0; i < seg.length; i++) {
    const t = seg[i];
    if (typeof t !== 'object') continue;
    const m = /^(\d*|&)(>>?|>\|)(&?)$/.exec(t.op);
    if (!m) continue;
    if (m[1] && m[1] !== '1' && m[1] !== '&') continue;   // another fd (2>...)
    if (m[3]) continue;                                   // >&2: a dup, no file
    const target = seg[i + 1];
    if (typeof target === 'string' && target !== '/dev/null') return true;
  }
  return false;
}

// The commands of a Bash line that search or read files: [{ cmd, args }] for each one that starts a pipeline
// (a `grep` after a `|` filters another command's output and reads no file). Writes (`cat > f`) don't count.
export function bashSearches(command) {
  // Heredoc bodies are data, not commands: keep only the line that opens them.
  const text = String(command || '').replace(/(<<-?\s*(['"]?)([A-Za-z_][\w-]*)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1');
  const toks = shellTokens(text);
  const segs = [];
  let seg = [], first = true;
  for (const t of toks) {
    if (typeof t === 'object' && ['|', ';', '&&', '||', '&'].includes(t.op)) {
      segs.push({ seg, first });
      first = t.op !== '|';
      seg = [];
    } else seg.push(t);
  }
  segs.push({ seg, first });
  const found = [];
  let cd;  // a `cd DIR` earlier in the line moves where later commands run
  for (const { seg: s, first: isFirst } of segs) {
    if (isFirst && typeof s[0] === 'string' && s[0] === 'cd' && s.length <= 2) {
      const d = typeof s[1] === 'string' ? s[1] : '~';
      cd = d.startsWith('/') || d.startsWith('~') || !cd ? d : `${cd}/${d}`;
      continue;
    }
    if (!isFirst || !s.length) continue;
    const words = [];
    for (let i = 0; i < s.length; i++) {
      const t = s[i];
      if (typeof t === 'object') { i++; continue; } // `< file`, `<<EOF`: skip the operator and its word
      words.push(t);
    }
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;  // VAR=value prefixes
    while (i < words.length && ['command', 'time', 'nice', 'nohup', 'exec'].includes(words[i])) i++;
    if (i >= words.length) continue;
    let name = basename(words[i]);
    let args = words.slice(i + 1);
    let where = cd;
    if (name === 'git') {
      let j = 0;
      while (j < args.length && args[j].startsWith('-')) {
        if (args[j] === '-C' && args[j + 1]) where = args[j + 1].startsWith('/') || args[j + 1].startsWith('~') || !where ? args[j + 1] : `${where}/${args[j + 1]}`;
        j += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[j]) ? 2 : 1;
      }
      if (args[j] !== 'grep') continue;
      name = 'git-grep';
      args = args.slice(j + 1);
    }
    if (name === 'sed' && !(args.some((a) => /^-[a-zA-Z]*n/.test(a) || a === '--quiet' || a === '--silent') && !args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')))) continue;
    if (!SEARCHERS.has(name) && !READERS.has(name)) continue;
    if (READERS.has(name) && writesFile(s)) continue;  // `cat a > b`, `sed -n p x > y`: a copy, not a look around
    found.push({ cmd: name, args, ...(where ? { cd: where } : {}) });
  }
  return found;
}

// What one Bash search reads: the paths it names (only words that exist on disk count as paths), or, when it
// names none, the working folder for a search and nothing (stdin) for a reader.
function bashTargets(io, s, cwd) {
  if (s.cd) cwd = absPath(io, s.cd, cwd);
  let words = s.args.filter((a) => !a.startsWith('-'));
  if (PATTERN_FIRST.has(s.cmd) && !s.args.some((a) => a === '-e' || a.startsWith('--regexp') || a === '-f')) words = words.slice(1);
  const paths = [];
  for (const w of words) {
    if (/[*?[]/.test(w) && !io.fs.existsSync(absPath(io, w, cwd))) {
      // a glob: its folder part decides where it reads
      const dir = w.split('/').slice(0, -1).join('/');
      if (dir && !/[*?[]/.test(dir)) paths.push(absPath(io, dir, cwd));
      else paths.push(resolve(cwd));
      continue;
    }
    const p = absPath(io, w, cwd);
    if (io.fs.existsSync(p)) paths.push(p);
  }
  if (paths.length) return paths;
  return SEARCHERS.has(s.cmd) ? [resolve(cwd)] : [];
}

// Paths a prompt names: absolute or relative paths that exist, and bare file names with an extension.
export function promptPaths(io, prompt, cwd, root) {
  const paths = new Set(), names = new Set();
  const text = String(prompt || '').slice(0, 20000).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');  // URLs are not files
  const re = /@?(?:~|\.{1,2})?\/?[\w@%+=:,.-]+(?:\/[\w@%+=:,.-]+)*/g;
  for (let m of text.match(re) || []) {
    if (m.startsWith('@')) m = m.slice(1);
    m = m.replace(/[.,:;]+$/, '');
    if (!m || /^[a-z]+:\/\//i.test(m) || m.includes('://')) continue;
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(basename(m)) && !/^v?\d+(\.\d+)+$/.test(m) && !/\.\d+$/.test(m);  // not versions or numbers
    if (m.includes('/') || m.startsWith('~')) {
      for (const base of new Set([cwd, root].filter(Boolean))) {
        const p = absPath(io, m, base);
        if (io.fs.existsSync(p)) paths.add(p);
      }
      if (hasExt) names.add(basename(m));
    } else if (hasExt) names.add(m);
  }
  return { paths: [...paths].slice(0, 100), names: [...names].slice(0, 100) };
}

// Why a gated call needs no RAG search first, or undefined when it does.
export function exemption(io, tool, ti, ctx) {
  const { cwd, root, state, cfg } = ctx;
  const named = state.named || { paths: [], names: [] };
  const isNamed = (p) => cfg.exemptPromptFiles && (named.paths.includes(p) || named.names.includes(basename(p)));
  const outside = (p) => cfg.exemptOutsideProject && !isInside(p, root) && !isInside(real(ctx.io, p), root);
  if (tool === 'Read') {
    const p = ti.file_path ? absPath(io, ti.file_path, cwd) : undefined;
    if (!p) return undefined;
    if (outside(p)) return 'outside the project';
    if (cfg.exemptWrittenFiles && (state.written || []).includes(p)) return 'written in this session';
    if (isNamed(p)) return 'named in the prompt';
    if (cfg.exemptNonText && NON_TEXT.has(extname(p).toLowerCase())) return 'not a text file';
    return undefined;
  }
  if (tool === 'Grep' || tool === 'Glob') {
    let base = ti.path ? absPath(io, ti.path, cwd) : resolve(cwd);
    if (tool === 'Glob' && typeof ti.pattern === 'string' && (isAbsolute(ti.pattern) || ti.pattern.startsWith('~'))) {
      const fixed = expandHome(io, ti.pattern).split('/').filter((s) => !/[*?[{]/.test(s));
      base = resolve(fixed.join('/') || '/');
    }
    if (outside(base)) return 'outside the project';
    if (ti.path && named.paths.includes(base) && cfg.exemptPromptFiles) return 'named in the prompt';
    return undefined;
  }
  return undefined;
}

// Is this call one the gate holds? { gated: false } or { gated: true, target } (target: a short label for the log).
export function classify(io, tool, ti, ctx) {
  if (!ctx.cfg.gatedTools.includes(tool)) return { gated: false };
  ti = ti || {};
  if (tool === 'Bash') {
    const found = bashSearches(ti.command);
    if (!found.length) return { gated: false };
    const { cwd, root, cfg } = ctx;
    const named = ctx.state.named || { paths: [], names: [] };
    for (const s of found) {
      for (const p of bashTargets(io, s, cwd)) {
        const inside = isInside(p, root) || isInside(real(io, p), root);
        if (!inside && cfg.exemptOutsideProject) continue;
        if (cfg.exemptPromptFiles && (named.paths.includes(p) || (p !== resolve(cwd) && named.names.includes(basename(p))))) continue;
        if (cfg.exemptWrittenFiles && (ctx.state.written || []).includes(p)) continue;
        return { gated: true, target: String(ti.command).slice(0, 80) };
      }
    }
    return { gated: false, exempt: 'targets outside the project or named in the prompt', target: String(ti.command).slice(0, 80) };
  }
  const why = exemption(io, tool, ti, ctx);
  const target = String(ti.file_path || ti.pattern || ti.path || '').slice(0, 80);
  return why ? { gated: false, exempt: why, target } : { gated: true, target };
}

// ---- state and log --------------------------------------------------------------------------------

export function safeId(sid) {
  return String(sid || 'nosession').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

function statePath(io, sid) { return join(dataDir(io), 'state', `${safeId(sid)}.json`); }

export function loadState(io, sid) {
  const s = readJson(io, statePath(io, sid));
  return s && typeof s === 'object' ? s : { fresh: true };
}

export function saveState(io, sid, state) {
  const f = statePath(io, sid);
  io.fs.mkdirSync(dirname(f), { recursive: true });
  const { fresh, ...rest } = state;
  const tmp = `${f}.${process.pid}.tmp`;
  io.fs.writeFileSync(tmp, JSON.stringify({ ...rest, updated: io.now().toISOString() }));
  io.fs.renameSync(tmp, f);
}

// Drop state files of sessions idle for longer than stateTtlDays. Run on a session's first prompt.
export function pruneState(io, cfg) {
  const dir = join(dataDir(io), 'state');
  let names = [];
  try { names = io.fs.readdirSync(dir); } catch { return; }
  const cutoff = io.now().getTime() - cfg.stateTtlDays * 86400000;
  for (const n of names) {
    try { if (io.fs.statSync(join(dir, n)).mtimeMs < cutoff) io.fs.unlinkSync(join(dir, n)); } catch {}
  }
}

export function writeLog(io, entry, cfg = DEFAULT_CONFIG) {
  try {
    const dir = dataDir(io);
    io.fs.mkdirSync(dir, { recursive: true });
    const f = join(dir, 'gate.jsonl');
    try { if (io.fs.statSync(f).size > cfg.logMaxBytes) io.fs.renameSync(f, `${f}.1`); } catch {}
    io.fs.appendFileSync(f, JSON.stringify({ ts: io.now().toISOString(), ...entry }) + '\n');
  } catch { /* a log that can't be written never stops a tool call */ }
}

// ---- the messages -----------------------------------------------------------------------------------

export function denyReason(id, tool, deferred = true) {
  const load = deferred
    ? ` If that tool isn't loaded yet, load it with ToolSearch (query "select:${SEARCH_TOOLS[0]},${SEARCH_TOOLS[1]}").`
    : '';
  return `rag-first: search this project's RAG before using ${tool} to look around. Call ${SEARCH_TOOLS[0]} `
    + `(or ${SEARCH_TOOLS[1]}) with project_id "${id}" and a query describing what you are looking for.${load} `
    + `After one RAG search, Grep, Glob, Read and Bash are allowed for the rest of this prompt: use them for exact `
    + `identifiers and to read the files and lines RAG pointed to.`;
}

export function nudgeText(id) {
  return `rag-first reminder: this project is indexed in enowx-rag (project_id "${id}"). Before grepping or reading `
    + `around, one call to ${SEARCH_TOOLS[0]} or ${SEARCH_TOOLS[1]} usually finds the right files faster and cheaper.`;
}

const show = (cfg, level) => cfg.display === 'all' || (cfg.display === 'changes' && level === 'change');

// ---- the hook ------------------------------------------------------------------------------------------

// decide(hookInput, io) -> { output?: object }. Reads and writes the session's state and the log.
export function decide(input, io = makeIO()) {
  const cfg = loadConfig(io);
  const event = input?.hook_event_name;
  const tool = input?.tool_name || '';
  const sid = input?.session_id;
  const cwd = input?.cwd || io.env.CLAUDE_PROJECT_DIR || process.cwd();
  const base = { session_id: sid, event, tool: tool || undefined };
  if (cfg.mode === 'off') return {};

  if (event === 'UserPromptSubmit') {
    const st = projectStatus(io, cwd, cfg);
    const state = loadState(io, sid);
    if (state.fresh) pruneState(io, cfg);
    const firstPrompt = !!state.fresh;
    Object.assign(state, {
      prompt_n: (state.prompt_n || 0) + 1, searched: false, denials: 0, attempted: 0, offLogged: false, searchFailed: false, letThrough: false,
      named: st.active || !io.env.ENOWX_SESSION ? promptPaths(io, input.prompt, cwd, st.root) : { paths: [], names: [] },
    });
    let output;
    if (!st.active && show(cfg, 'info') && !state.offShown && !st.quiet) {
      output = { systemMessage: `${ICON} rag-first off here: ${st.reason}` };
      state.offShown = true;
    }
    saveState(io, sid, state);
    writeLog(io, { ...base, decision: 'reset', project_id: st.id, reason: st.active ? undefined : st.reason, first: firstPrompt || undefined }, cfg);
    return output ? { output } : {};
  }

  if (event === 'PostToolUse') {
    if (io.env.ENOWX_SESSION) return {};
    const state = loadState(io, sid);
    if (SEARCH_TOOLS.includes(tool)) {
      const was = state.searched;
      state.searched = true;
      state.mcp = true;
      state.rag_calls = (state.rag_calls || 0) + 1;
      saveState(io, sid, state);
      const pid = input.tool_input?.project_id;
      writeLog(io, { ...base, decision: 'searched', project_id: pid, detail: String(input.tool_input?.query || '').slice(0, 80) }, cfg);
      if (!was && show(cfg, 'info')) return { output: { systemMessage: `${ICON} rag-first: RAG searched${pid ? ` (${pid})` : ''} · Grep/Glob/Read/Bash open for this prompt` } };
      return {};
    }
    if (WRITE_TOOLS.has(tool)) {
      const p = input.tool_input?.file_path || input.tool_input?.notebook_path;
      if (p) {
        const abs = absPath(io, p, cwd);
        state.written = [...new Set([...(state.written || []), abs])].slice(-200);
        saveState(io, sid, state);
      }
    }
    return {};
  }

  // The RAG search itself was refused (no permission, auto mode's classifier) or failed: the model can't
  // satisfy the gate, so open it for the rest of this prompt instead of making it loop.
  if ((event === 'PermissionDenied' || event === 'PostToolUseFailure') && SEARCH_TOOLS.includes(tool)) {
    if (io.env.ENOWX_SESSION) return {};
    const state = loadState(io, sid);
    const first = !state.searchFailed;
    state.searchFailed = true;
    saveState(io, sid, state);
    const why = event === 'PermissionDenied' ? 'RAG search not permitted' : 'RAG search failed';
    writeLog(io, { ...base, decision: 'search-failed', reason: why, detail: String(input.error || input.reason || '').slice(0, 120) || undefined }, cfg);
    return first && show(cfg, 'change')
      ? { output: { systemMessage: `${ICON} rag-first: ${why}; Grep/Glob/Read/Bash let through for this prompt` } }
      : {};
  }

  // The model is calling a RAG search: note it. If no PostToolUse follows (permission refused, server error),
  // the next gated call is let through. With allowSearchTools, approve the read-only search outright.
  if (event === 'PreToolUse' && SEARCH_TOOLS.includes(tool)) {
    if (io.env.ENOWX_SESSION) return {};
    const state = loadState(io, sid);
    state.attempted = (state.attempted || 0) + 1;
    saveState(io, sid, state);
    if (cfg.allowSearchTools) {
      writeLog(io, { ...base, decision: 'approve', reason: 'allowSearchTools', project_id: input.tool_input?.project_id }, cfg);
      return { output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'rag-first: read-only RAG search (allowSearchTools)' } } };
    }
    return {};
  }

  if (event === 'PreToolUse') {
    if (!cfg.gatedTools.includes(tool)) return {};
    if (io.env.ENOWX_SESSION) return {};
    // Cheap checks first: is this a search at all? (Bash `npm test` is not.)
    if (tool === 'Bash' && !bashSearches(input.tool_input?.command).length) return {};
    const st = projectStatus(io, cwd, cfg);
    const state = loadState(io, sid);
    const offOnce = (reason) => {
      if (!state.offLogged) { writeLog(io, { ...base, decision: 'off', reason }, cfg); state.offLogged = true; saveState(io, sid, state); }
      return {};
    };
    if (!st.active) return offOnce(st.reason);
    const ctx = { io, cwd: resolve(cwd), root: st.root, state, cfg };
    const c = classify(io, tool, input.tool_input, ctx);
    if (!c.gated) {
      if (c.exempt) writeLog(io, { ...base, decision: 'exempt', project_id: st.id, reason: c.exempt, detail: c.target }, cfg);
      return {};
    }
    if (state.searched) {
      writeLog(io, { ...base, decision: 'allow', project_id: st.id, detail: c.target }, cfg);
      return {};
    }
    if (!state.searchFailed && (state.attempted || 0) > 0) {
      state.searchFailed = true;   // a search was called this prompt but never completed
      saveState(io, sid, state);
      writeLog(io, { ...base, decision: 'search-failed', project_id: st.id, reason: 'a RAG search was called but did not complete (refused or failed)' }, cfg);
      writeLog(io, { ...base, decision: 'let-through', project_id: st.id, reason: 'the RAG search was refused or failed this prompt', detail: c.target }, cfg);
      return show(cfg, 'change')
        ? { output: { systemMessage: `${ICON} rag-first: the RAG search didn't complete (refused or failed); ${tool} let through for this prompt` } }
        : {};
    }
    if (state.searchFailed) {
      writeLog(io, { ...base, decision: 'let-through', project_id: st.id, reason: 'the RAG search was refused or failed this prompt', detail: c.target }, cfg);
      return {};
    }
    const mcp = mcpStatus(io, input, state, ctx.cwd, st.root);
    if (!mcp.ok) return offOnce(mcp.reason);
    if ((state.denials || 0) >= cfg.maxDenials) {
      const first = !state.letThrough;
      state.letThrough = true;
      state.let_through = (state.let_through || 0) + 1;
      saveState(io, sid, state);
      writeLog(io, { ...base, decision: 'let-through', project_id: st.id, reason: `${state.denials} denials this prompt (maxDenials ${cfg.maxDenials})`, detail: c.target }, cfg);
      return first && show(cfg, 'change')
        ? { output: { systemMessage: `${ICON} rag-first: let ${tool} through after ${state.denials} denials without a RAG search (loop guard)` } }
        : {};
    }
    state.denials = (state.denials || 0) + 1;
    saveState(io, sid, state);
    const label = `${state.denials}/${cfg.maxDenials}`;
    if (cfg.mode === 'nudge') {
      writeLog(io, { ...base, decision: 'nudge', project_id: st.id, detail: c.target, n: state.denials }, cfg);
      const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: nudgeText(st.id) } };
      if (show(cfg, 'change')) output.systemMessage = `${ICON} rag-first: reminded to search RAG (${st.id}) before ${tool} · ${label}`;
      return { output };
    }
    writeLog(io, { ...base, decision: 'deny', project_id: st.id, detail: c.target, n: state.denials, mcp: mcp.via }, cfg);
    const output = {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyReason(st.id, tool, !state.pinned) },
    };
    if (show(cfg, 'change')) output.systemMessage = `${ICON} rag-first: held ${tool} until a RAG search (${st.id}) · ${label}`;
    return { output };
  }
  return {};
}

// The hooks module's helper: should the two search tools be pinned in front for this session? Also records
// that the enowx-rag MCP server is connected (it is: the engine is describing its tools).
export function pinDecision(input, io = makeIO()) {
  const cfg = loadConfig(io);
  const sid = input?.session_id;
  try {
    if (sid) {
      const dir = join(dataDir(io), 'state');
      io.fs.mkdirSync(dir, { recursive: true });
      io.fs.writeFileSync(join(dir, `${safeId(sid)}.mcp`), '1');
    }
  } catch {}
  if (cfg.mode === 'off' || !cfg.pinTools) return { pin: false, reason: cfg.mode === 'off' ? 'mode off' : 'pinTools false' };
  const st = projectStatus(io, input?.cwd, cfg);
  if (!st.active) return { pin: false, reason: st.reason };
  if (sid) { const s = loadState(io, sid); s.pinned = true; saveState(io, sid, s); }
  writeLog(io, { session_id: sid, event: 'tool.describe', decision: 'pin', project_id: st.id }, cfg);
  return { pin: true, project_id: st.id };
}
