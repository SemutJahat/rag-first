// The gate's decisions, event by event, through decide() with a stubbed filesystem and env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memfs } from './helpers/memfs.mjs';
import { decide, pinDecision } from '../scripts/lib.mjs';

const HOME = '/home/u';
const ANT = '/home/u/code/antares';
const T = '/t/s1.jsonl';
const RAG = 'mcp__enowx-rag__rag_retrieve_context';

function world({ files = {}, env = {}, config } = {}) {
  const m = memfs({
    [`${HOME}/.enowx-rag/project_dirs.json`]: { antares: [ANT] },
    [`${ANT}/.git`]: null,
    [`${ANT}/internal/agent/compact.go`]: 'package agent',
    [`${ANT}/README.md`]: '# antares',
    '/home/u/code/plain/.git': null,
    [T]: JSON.stringify({ attachment: { type: 'deferred_tools_delta', addedNames: [RAG, 'mcp__enowx-rag__rag_semantic_search'] } }) + '\n',
    ...(config ? { '/data/config.json': config } : {}),
    ...files,
  });
  const io = { fs: m.fs, env: { RAG_FIRST_DIR: '/data', ...env }, home: HOME, now: () => new Date('2026-11-20T00:00:00Z') };
  const ev = (hook_event_name, extra = {}) => decide({ session_id: 's1', transcript_path: T, cwd: ANT, hook_event_name, ...extra }, io).output;
  const prompt = (p = 'how does compaction work?') => ev('UserPromptSubmit', { prompt: p });
  const pre = (tool_name, tool_input) => ev('PreToolUse', { tool_name, tool_input });
  const post = (tool_name, tool_input = {}) => ev('PostToolUse', { tool_name, tool_input });
  const log = () => (m.read('/data/gate.jsonl') || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { m, io, ev, prompt, pre, post, log };
}
const decision = (o) => o?.hookSpecificOutput?.permissionDecision;

test('strict: deny until a RAG search, then allow; the next prompt resets', () => {
  const w = world();
  w.prompt();
  const d = w.pre('Bash', { command: 'grep -rn compact .' });
  assert.equal(decision(d), 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /mcp__enowx-rag__rag_retrieve_context.*project_id "antares"/);
  assert.match(d.systemMessage, /held Bash until a RAG search \(antares\) · 1\/3/);
  assert.equal(decision(w.pre('Grep', { pattern: 'compact' })), 'deny');
  const s = w.post(RAG, { project_id: 'antares', query: 'compaction' });
  assert.match(s.systemMessage, /RAG searched \(antares\)/);
  assert.equal(w.pre('Grep', { pattern: 'compact' }), undefined);
  assert.equal(w.pre('Read', { file_path: `${ANT}/internal/agent/agent.go` }), undefined);
  w.prompt('next question');
  assert.equal(decision(w.pre('Grep', { pattern: 'x' })), 'deny');
  assert.deepEqual(w.log().map((e) => e.decision), ['reset', 'deny', 'deny', 'searched', 'allow', 'allow', 'reset', 'deny']);
});

test('the gate never answers "allow" for a gated tool: permissions stay the user\'s', () => {
  const w = world();
  w.prompt();
  for (let i = 0; i < 6; i++) assert.notEqual(decision(w.pre('Grep', { pattern: 'x' })), 'allow');
  w.post(RAG);
  assert.equal(w.pre('Grep', { pattern: 'x' }), undefined);
});

test('loop guard: after maxDenials denials in a prompt, calls go through and it is logged', () => {
  const w = world({ config: { maxDenials: 2 } });
  w.prompt();
  assert.equal(decision(w.pre('Grep', { pattern: 'a' })), 'deny');
  assert.equal(decision(w.pre('Grep', { pattern: 'b' })), 'deny');
  const third = w.pre('Grep', { pattern: 'c' });
  assert.equal(decision(third), undefined);
  assert.match(third.systemMessage, /let Grep through after 2 denials/);
  assert.equal(w.pre('Grep', { pattern: 'd' }), undefined, 'the line shows once');
  assert.deepEqual(w.log().filter((e) => e.decision === 'let-through').length, 2);
});

test('maxDenials 0: never denies (logs let-through)', () => {
  const w = world({ config: { maxDenials: 0 } });
  w.prompt();
  assert.equal(decision(w.pre('Grep', { pattern: 'a' })), undefined);
});

test('nudge: allows with a reminder in additionalContext, no permissionDecision', () => {
  const w = world({ config: { mode: 'nudge' } });
  w.prompt();
  const o = w.pre('Bash', { command: 'rg compact' });
  assert.equal(decision(o), undefined);
  assert.match(o.hookSpecificOutput.additionalContext, /project_id "antares"/);
  assert.match(o.systemMessage, /reminded/);
  assert.equal(w.log().at(-1).decision, 'nudge');
});

test('off: no output, no log', () => {
  const w = world({ config: { mode: 'off' } });
  assert.equal(w.prompt(), undefined);
  assert.equal(w.pre('Grep', { pattern: 'a' }), undefined);
  assert.deepEqual(w.log(), []);
});

test('display "changes" hides the searched line, "off" hides all lines; decisions are the same', () => {
  const ch = world({ config: { display: 'changes' } });
  ch.prompt();
  assert.ok(ch.pre('Grep', { pattern: 'a' }).systemMessage);
  assert.equal(ch.post(RAG), undefined);
  const off = world({ config: { display: 'off' } });
  off.prompt();
  const o = off.pre('Grep', { pattern: 'a' });
  assert.equal(decision(o), 'deny');
  assert.equal(o.systemMessage, undefined);
});

test('gate off: ENOWX_SESSION, a non-indexed project with indexNew off, no git root, no MCP server', () => {
  const enowx = world({ env: { ENOWX_SESSION: 'x' } });
  enowx.prompt();
  assert.equal(enowx.pre('Grep', { pattern: 'a' }), undefined);

  const plain = world({ config: { indexNew: false } });
  const note = plain.ev('UserPromptSubmit', { cwd: '/home/u/code/plain', prompt: 'hi' });
  assert.match(note.systemMessage, /off here: project not indexed in enowx-rag \(would be project_id "plain"\)/);
  assert.equal(plain.ev('PreToolUse', { cwd: '/home/u/code/plain', tool_name: 'Grep', tool_input: { pattern: 'a' } }), undefined);
  assert.equal(plain.ev('UserPromptSubmit', { cwd: '/home/u/code/plain', prompt: 'again' }), undefined, 'the note shows once per session');

  const loose = world();
  assert.equal(loose.ev('UserPromptSubmit', { cwd: '/tmp/loose', prompt: 'hi' }), undefined, 'not a code project: silent');
  assert.equal(loose.ev('PreToolUse', { cwd: '/tmp/loose', tool_name: 'Grep', tool_input: { pattern: 'a' } }), undefined);

  const nomcp = world({ files: { [T]: JSON.stringify({ attachment: { type: 'deferred_tools_delta', addedNames: ['Monitor'] } }) + '\n' } });
  nomcp.prompt();
  assert.equal(nomcp.pre('Grep', { pattern: 'a' }), undefined);
  assert.equal(nomcp.pre('Grep', { pattern: 'b' }), undefined);
  const offs = nomcp.log().filter((e) => e.decision === 'off');
  assert.equal(offs.length, 1, 'logged once per prompt');
  assert.match(offs[0].reason, /not loaded in this session/);
});

test('a RAG search that was called but never completed (refused, failed) lets the next call through', () => {
  const w = world();
  w.prompt();
  assert.equal(decision(w.pre('Bash', { command: 'grep -rn x .' })), 'deny');
  assert.equal(w.pre(RAG, { project_id: 'antares', query: 'x' }), undefined, 'no permission decision on the search itself');
  const o = w.pre('Bash', { command: 'grep -rn x .' });
  assert.equal(decision(o), undefined);
  assert.match(o.systemMessage, /didn't complete/);
  assert.equal(w.pre('Grep', { pattern: 'y' }), undefined);
  assert.ok(w.log().some((e) => e.decision === 'search-failed'));
});

test('PermissionDenied / PostToolUseFailure on the search open the gate for the prompt', () => {
  for (const evName of ['PermissionDenied', 'PostToolUseFailure']) {
    const w = world();
    w.prompt();
    const o = w.ev(evName, { tool_name: RAG, tool_input: {} });
    assert.match(o.systemMessage, /let through/);
    assert.equal(w.pre('Grep', { pattern: 'x' }), undefined);
    w.prompt('next');
    assert.equal(decision(w.pre('Grep', { pattern: 'x' })), 'deny', 'reset by the next prompt');
  }
});

test('allowSearchTools: approves the read-only search (and only it)', () => {
  const w = world({ config: { allowSearchTools: true } });
  w.prompt();
  assert.equal(decision(w.pre(RAG, { project_id: 'antares' })), 'allow');
  const plain = world();
  plain.prompt();
  assert.equal(plain.pre(RAG, { project_id: 'antares' }), undefined);
});

test('exempt: files named in the prompt, files written this session, outside the project', () => {
  const w = world({ files: { '/tmp/server.log': 'x' } });
  w.prompt('explain internal/agent/compact.go');
  assert.equal(w.pre('Read', { file_path: `${ANT}/internal/agent/compact.go` }), undefined);
  assert.equal(w.pre('Bash', { command: 'tail -20 /tmp/server.log' }), undefined);
  w.post('Write', { file_path: `${ANT}/PLAN.md` });
  assert.equal(w.pre('Read', { file_path: `${ANT}/PLAN.md` }), undefined);
  assert.equal(decision(w.pre('Read', { file_path: `${ANT}/README.md` })), 'deny');
  const ex = w.log().filter((e) => e.decision === 'exempt').map((e) => e.reason);
  assert.deepEqual(ex, ['named in the prompt', 'targets outside the project or named in the prompt', 'written in this session']);
});

test('non-search Bash is never touched or logged', () => {
  const w = world();
  w.prompt();
  assert.equal(w.pre('Bash', { command: 'npm test 2>&1 | tail -30' }), undefined);
  assert.equal(w.pre('Bash', { command: 'git status' }), undefined);
  assert.deepEqual(w.log().map((e) => e.decision), ['reset']);
});

test('state of old sessions is pruned on a new session\'s first prompt', () => {
  const w = world();
  w.m.put('/data/state/old.json', '{}', Date.parse('2026-10-01T00:00:00Z'));
  w.m.put('/data/state/recent.json', '{}', Date.parse('2026-11-19T00:00:00Z'));
  w.prompt();
  assert.equal(w.m.fs.existsSync('/data/state/old.json'), false);
  assert.equal(w.m.fs.existsSync('/data/state/recent.json'), true);
});

test('the log rotates past logMaxBytes', () => {
  const w = world({ config: { logMaxBytes: 10 } });
  w.prompt();
  w.prompt();
  assert.ok(w.m.fs.existsSync('/data/gate.jsonl.1'));
});

test('pinDecision: pins in an indexed project, records the MCP server, not elsewhere or when off', () => {
  const w = world();
  assert.deepEqual(pinDecision({ cwd: ANT, session_id: 's1' }, w.io), { pin: true, project_id: 'antares' });
  assert.ok(w.m.fs.existsSync('/data/state/s1.mcp'));
  assert.deepEqual(pinDecision({ cwd: '/home/u/code/plain', session_id: 's2' }, w.io), { pin: true, index: true, project_id: 'plain' });
  assert.equal(pinDecision({ cwd: '/tmp/loose', session_id: 's4' }, w.io).pin, false);
  const noIdx = world({ config: { indexNew: false } });
  assert.equal(pinDecision({ cwd: '/home/u/code/plain', session_id: 's2' }, noIdx.io).pin, false);
  assert.equal(pinDecision({ cwd: ANT, session_id: 's3' }, { ...w.io, env: { ...w.io.env, ENOWX_SESSION: '1' } }).pin, false);
  const np = world({ config: { pinTools: false } });
  assert.equal(pinDecision({ cwd: ANT, session_id: 's1' }, np.io).pin, false);
});

// ---- indexNew: a git project that isn't in enowx-rag yet ----------------------------------------------

const PLAIN = '/home/u/code/plain';
const IDX = 'mcp__enowx-rag__rag_index_project';

function plainWorld(opts) {
  const w = world(opts);
  const at = (hook_event_name, extra = {}) => w.ev(hook_event_name, { cwd: PLAIN, ...extra });
  return {
    ...w,
    prompt: (p = 'build the thing') => at('UserPromptSubmit', { prompt: p }),
    pre: (tool_name, tool_input) => at('PreToolUse', { tool_name, tool_input }),
    post: (tool_name, tool_input = {}) => at('PostToolUse', { tool_name, tool_input }),
    at,
  };
}

test('indexNew: an unindexed git project tells the model to index it, every prompt until it is', () => {
  const w = plainWorld();
  const o = w.prompt();
  const ctx = o.hookSpecificOutput.additionalContext;
  assert.equal(o.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(ctx, /rag_index_project with project_id "plain" and directory "\/home\/u\/code\/plain"/);
  assert.match(ctx, /use "code-plain"/);
  assert.match(o.systemMessage, /not indexed in enowx-rag yet · asked Claude to index it as "plain"/);
  const again = w.prompt('next');
  assert.match(again.hookSpecificOutput.additionalContext, /rag_index_project/);
  assert.equal(again.systemMessage, undefined, 'the user sees the line once per session');
  assert.equal(w.log()[0].decision, 'index-needed');
});

test('indexNew: gated tools are denied until rag_index_project succeeds; a search does not count', () => {
  const w = plainWorld();
  w.prompt();
  const d = w.pre('Grep', { pattern: 'main' });
  assert.equal(decision(d), 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /not indexed.*rag_index_project with project_id "plain"/);
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /select:mcp__enowx-rag__rag_index_project/);
  assert.match(d.systemMessage, /held Grep until indexing \(plain\) · 1\/3/);
  w.post(RAG, { project_id: 'plain', query: 'x' });
  assert.equal(decision(w.pre('Read', { file_path: `${PLAIN}/main.go` })), 'deny', 'searching an empty project does not open it');
  assert.equal(w.pre(IDX, { project_id: 'plain', directory: PLAIN }), undefined, 'the index call itself is never held');
  const done = w.post(IDX, { project_id: 'plain', directory: PLAIN });
  assert.match(done.systemMessage, /project indexed \(plain\)/);
  assert.equal(w.pre('Grep', { pattern: 'main' }), undefined);
  assert.equal(w.prompt('later').hookSpecificOutput, undefined, 'no index request once indexed');
});

test('indexNew: once project_dirs.json lists the folder, the normal search gate takes over', () => {
  const w = plainWorld();
  w.prompt();
  w.m.fs.writeFileSync(`${HOME}/.enowx-rag/project_dirs.json`, JSON.stringify({ antares: [ANT], plain: [PLAIN] }));
  w.prompt('next');
  const d = w.pre('Grep', { pattern: 'main' });
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /search this project's RAG.*project_id "plain"/);
});

test('indexNew: a refused, failed or unfinished index call lets tools through for the prompt', () => {
  for (const ev of ['PermissionDenied', 'PostToolUseFailure']) {
    const w = plainWorld();
    w.prompt();
    const o = w.at(ev, { tool_name: IDX, tool_input: { project_id: 'plain' }, error: 'nope' });
    assert.match(o.systemMessage, /indexing (not permitted|failed); Grep\/Glob\/Read\/Bash let through/);
    assert.equal(w.pre('Grep', { pattern: 'a' }), undefined);
    w.prompt('next');
    assert.equal(decision(w.pre('Grep', { pattern: 'a' })), 'deny', 'held again on the next prompt');
  }
  const w = plainWorld();
  w.prompt();
  w.pre(IDX, { project_id: 'plain', directory: PLAIN });
  assert.equal(w.pre('Grep', { pattern: 'a' }), undefined, 'called but never completed');
});

test('indexNew: loop guard, nudge mode, no MCP server, indexNew off', () => {
  const g = plainWorld({ config: { maxDenials: 1 } });
  g.prompt();
  assert.equal(decision(g.pre('Grep', { pattern: 'a' })), 'deny');
  const through = g.pre('Grep', { pattern: 'b' });
  assert.equal(decision(through), undefined);
  assert.match(through.systemMessage, /after 1 denials without indexing \(loop guard\)/);

  const n = plainWorld({ config: { mode: 'nudge' } });
  n.prompt();
  const o = n.pre('Grep', { pattern: 'a' });
  assert.equal(decision(o), undefined);
  assert.match(o.hookSpecificOutput.additionalContext, /rag_index_project/);

  const nomcp = plainWorld({ files: { [T]: JSON.stringify({ attachment: { type: 'deferred_tools_delta', addedNames: ['Monitor'] } }) + '\n' } });
  const p = nomcp.prompt();
  assert.equal(p.hookSpecificOutput, undefined, 'no index request without the MCP server');
  assert.match(p.systemMessage, /off here: project not indexed/);
  assert.equal(nomcp.pre('Grep', { pattern: 'a' }), undefined);

  const off = plainWorld({ config: { indexNew: false } });
  assert.equal(off.prompt().hookSpecificOutput, undefined);
  assert.equal(off.pre('Grep', { pattern: 'a' }), undefined);
});
