// Unit tests of scripts/lib.mjs with a stubbed filesystem (test/helpers/memfs.mjs) and env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memfs } from './helpers/memfs.mjs';
import {
  shellTokens, bashSearches, promptPaths, projectStatus, projectIdCandidates, findIndexedProject, mcpStatus,
  scanTranscript, loadConfig, DEFAULT_CONFIG, isInside, classify,
} from '../scripts/lib.mjs';

const HOME = '/home/u';
const ANT = '/home/u/code/antares';
function world(files = {}, env = {}) {
  const m = memfs({
    [`${HOME}/.enowx-rag/project_dirs.json`]: { antares: [ANT], 'code-dup': ['/home/u/code/dup'] },
    [`${ANT}/.git`]: null,
    [`${ANT}/internal/agent/compact.go`]: 'package agent',
    [`${ANT}/README.md`]: '# antares',
    '/home/u/code/other/.git': null,
    ...files,
  });
  return { m, io: { fs: m.fs, env: { RAG_FIRST_DIR: '/data', ...env }, home: HOME, now: () => new Date('2026-11-20T00:00:00Z') } };
}
const cfg = (over = {}) => ({ ...structuredClone(DEFAULT_CONFIG), ...over });

test('shellTokens: quotes, operators and fd redirects', () => {
  assert.deepEqual(shellTokens(`grep -rn "a b" . | head`), ['grep', '-rn', 'a b', '.', { op: '|' }, 'head']);
  assert.deepEqual(shellTokens(`cd x && rg 'q' 2>/dev/null`), ['cd', 'x', { op: '&&' }, 'rg', 'q', { op: '2>' }, '/dev/null']);
});

test('bashSearches: what counts as a search or read', () => {
  const names = (c) => bashSearches(c).map((s) => s.cmd);
  assert.deepEqual(names('rg foo'), ['rg']);
  assert.deepEqual(names('grep -rn x . 2>/dev/null | head -50'), ['grep']);
  assert.deepEqual(names('git grep foo'), ['git-grep']);
  assert.deepEqual(names('find . -name "*.go"'), ['find']);
  assert.deepEqual(names('cat a.go; head -n 5 b.go && tail c.go'), ['cat', 'head', 'tail']);
  assert.deepEqual(names('sed -n 10,20p a.go'), ['sed']);
  assert.deepEqual(names('sed -i s/a/b/ a.go'), [], 'sed -i edits');
  assert.deepEqual(names('sed s/a/b/ a.go'), [], 'sed without -n is not a read');
  assert.deepEqual(names('npm test | tail -20'), [], 'tail after a pipe reads stdin');
  assert.deepEqual(names('go test ./... 2>&1 | grep FAIL'), []);
  assert.deepEqual(names('git log --oneline | head'), []);
  assert.deepEqual(names('ls -la'), []);
  assert.deepEqual(names('cat a > b'), [], 'a copy');
  assert.deepEqual(names('cat > f <<EOF\ngrep x y\nEOF'), [], 'heredoc body is data');
  assert.deepEqual(names('FOO=1 rg x'), ['rg']);
  assert.deepEqual(names('grep x . > out.txt'), ['grep'], 'a search with its output saved is still a search');
  assert.equal(bashSearches('cd web && rg x src')[0].cd, 'web');
  assert.equal(bashSearches('git -C sub grep foo')[0].cd, 'sub');
});

test('promptPaths: named paths and bare file names', () => {
  const { io } = world();
  const r = promptPaths(io, 'look at internal/agent/compact.go and README.md, also https://x.io/a.js and v1.2.3', ANT, ANT);
  assert.ok(r.paths.includes(`${ANT}/internal/agent/compact.go`));
  assert.ok(r.names.includes('compact.go'));
  assert.ok(r.names.includes('README.md'));
  assert.ok(!r.names.includes('a.js'), 'URLs are not files');
  assert.ok(!r.names.includes('v1.2.3'));
});

test('projectStatus: indexed project is active, with its project_id', () => {
  const { io } = world();
  assert.deepEqual(projectStatus(io, `${ANT}/internal`, cfg()), { active: true, id: 'antares', root: ANT });
});

test('projectStatus: off in enowX, home, Desktop, Downloads, Documents, no git root, not indexed', () => {
  const { io } = world({ [`${HOME}/Desktop`]: null });
  assert.match(projectStatus({ ...io, env: { ENOWX_SESSION: 'abc' } }, ANT, cfg()).reason, /enowX/);
  for (const d of [HOME, `${HOME}/Desktop`, `${HOME}/Downloads`, `${HOME}/Documents`]) {
    const st = projectStatus(io, d, cfg());
    assert.equal(st.active, false, d);
    assert.match(st.reason, /not a code project/);
  }
  assert.match(projectStatus(io, '/tmp/loose', cfg()).reason, /no git root/);
  const ni = projectStatus(io, '/home/u/code/other/src', cfg());
  assert.equal(ni.active, false);
  assert.match(ni.reason, /not indexed.*"other"/);
});

test('projectStatus: a dotfiles repo in ~ is still not a code project', () => {
  const { io } = world({ [`${HOME}/.git`]: null });
  assert.equal(projectStatus(io, `${HOME}/notes`, cfg()).active, false);
});

test('project id: CLAUDE.md rule and the <parent>-<folder> fallback, found through project_dirs.json', () => {
  assert.deepEqual(projectIdCandidates('/a/Script/Saas App'), ['saas-app', 'script-saas-app']);
  const { io } = world({ '/home/u/code/dup/.git': null });
  assert.deepEqual(findIndexedProject(io, '/home/u/code/dup', cfg()), { id: 'code-dup', dir: '/home/u/code/dup' });
});

test('findIndexedProject: longest match wins; config "projects" adds folders', () => {
  const { io } = world({ [`${HOME}/.enowx-rag/project_dirs.json`]: { mono: ['/home/u/mono'], web: ['/home/u/mono/web'] } });
  assert.equal(findIndexedProject(io, '/home/u/mono/web/src', cfg()).id, 'web');
  assert.equal(findIndexedProject(io, '/home/u/mono/api', cfg()).id, 'mono');
  assert.equal(findIndexedProject(io, '/srv/x', cfg({ projects: { '/srv/x': 'xid' } })).id, 'xid');
  const broken = world({ [`${HOME}/.enowx-rag/project_dirs.json`]: '{not json' });
  assert.equal(findIndexedProject(broken.io, ANT, cfg()), undefined);
});

const delta = (type, addedNames, removedNames = []) => JSON.stringify({ type: 'attachment', attachment: { type, addedNames, removedNames } });

test('mcpStatus: from the transcript (deferred tools / MCP instructions), incrementally', () => {
  const t = '/t/s.jsonl';
  const { io, m } = world({ [t]: [delta('deferred_tools_delta', ['CronCreate', 'Monitor']), ''].join('\n') });
  const state = {};
  const r1 = mcpStatus(io, { session_id: 's', transcript_path: t }, state, ANT, ANT);
  assert.deepEqual(r1, { ok: false, reason: 'enowx-rag MCP server not loaded in this session' });
  // the server connects later
  m.fs.appendFileSync(t, delta('deferred_tools_delta', ['mcp__enowx-rag__rag_semantic_search']) + '\n');
  const r2 = mcpStatus(io, { session_id: 's', transcript_path: t }, state, ANT, ANT);
  assert.deepEqual(r2, { ok: true, via: 'transcript' });
  assert.equal(state.mcp, true);
  assert.deepEqual(mcpStatus(io, { session_id: 's', transcript_path: t }, state, ANT, ANT), { ok: true, via: 'cached' });
});

test('scanTranscript: mcp_instructions_delta names the server; a partial last line waits', () => {
  const t = '/t/x.jsonl';
  const line = delta('mcp_instructions_delta', ['enowx', 'enowx-rag']);
  const { io } = world({ [t]: line.slice(0, 20) });
  let s = scanTranscript(io, t);
  assert.equal(s.offset, 0);
  const w2 = world({ [t]: line + '\n' });
  s = scanTranscript(w2.io, t);
  assert.deepEqual(s.servers, ['enowx-rag']);
  assert.ok(s.offset > 0);
});

test('mcpStatus: no transcript -> config files (user, local, .mcp.json); the module marker wins', () => {
  const none = world();
  assert.equal(mcpStatus(none.io, { session_id: 's' }, {}, ANT, ANT).ok, false);
  const user = world({ [`${HOME}/.claude.json`]: { mcpServers: { 'enowx-rag': { command: 'x' } } } });
  assert.deepEqual(mcpStatus(user.io, { session_id: 's' }, {}, ANT, ANT), { ok: true, via: 'config' });
  const local = world({ [`${HOME}/.claude.json`]: { projects: { [ANT]: { mcpServers: { 'enowx-rag': {} } } } } });
  assert.equal(mcpStatus(local.io, { session_id: 's' }, {}, ANT, ANT).ok, true);
  const proj = world({ [`${ANT}/.mcp.json`]: { mcpServers: { 'enowx-rag': {} } } });
  assert.equal(mcpStatus(proj.io, { session_id: 's' }, {}, ANT, ANT).ok, true);
  const mod = world({ '/data/state/s.mcp': '1' });
  assert.deepEqual(mcpStatus(mod.io, { session_id: 's' }, {}, ANT, ANT), { ok: true, via: 'module' });
});

test('loadConfig: plugin config, then the data folder, then $RAG_FIRST_CONFIG; bad values fall back', () => {
  const { io } = world({ '/data/config.json': { mode: 'nudge', display: 'loud', maxDenials: -1 }, '/c.json': { gatedTools: ['Read'] } });
  const c = loadConfig({ ...io, env: { ...io.env, RAG_FIRST_CONFIG: '/c.json' } });
  assert.equal(c.mode, 'nudge');
  assert.equal(c.display, 'all');
  assert.equal(c.maxDenials, 3);
  assert.deepEqual(c.gatedTools, ['Read']);
  assert.equal(loadConfig({ ...io, env: { ...io.env, RAG_FIRST_MODE: 'off' } }).mode, 'off');
  assert.equal(loadConfig({ ...io, env: { ...io.env, RAG_FIRST_MODE: 'bogus' } }).mode, 'strict');
});

test('isInside', () => {
  assert.ok(isInside('/a/b/c', '/a/b'));
  assert.ok(isInside('/a/b', '/a/b'));
  assert.ok(!isInside('/a/bc', '/a/b'));
});

test('classify: exemptions for Read, Grep, Glob and Bash', () => {
  const { io } = world({ '/tmp/x.log': 'log', [`${ANT}/shot.png`]: 'png' });
  const state = { named: { paths: [`${ANT}/README.md`], names: ['compact.go'] }, written: [`${ANT}/notes.md`] };
  const ctx = { io, cwd: ANT, root: ANT, state, cfg: cfg() };
  const c = (tool, ti) => classify(io, tool, ti, ctx);
  assert.equal(c('Read', { file_path: `${ANT}/internal/agent/agent.go` }).gated, true);
  assert.equal(c('Read', { file_path: '/tmp/x.log' }).exempt, 'outside the project');
  assert.equal(c('Read', { file_path: `${ANT}/notes.md` }).exempt, 'written in this session');
  assert.equal(c('Read', { file_path: `${ANT}/README.md` }).exempt, 'named in the prompt');
  assert.equal(c('Read', { file_path: `${ANT}/internal/agent/compact.go` }).exempt, 'named in the prompt');
  assert.equal(c('Read', { file_path: `${ANT}/shot.png` }).exempt, 'not a text file');
  assert.equal(c('Grep', { pattern: 'x' }).gated, true);
  assert.equal(c('Grep', { pattern: 'x', path: '/tmp' }).exempt, 'outside the project');
  assert.equal(c('Glob', { pattern: '/tmp/**/*.log' }).exempt, 'outside the project');
  assert.equal(c('Glob', { pattern: '**/*.go' }).gated, true);
  assert.equal(c('Bash', { command: 'rg foo' }).gated, true);
  assert.equal(c('Bash', { command: 'tail -50 /tmp/x.log' }).gated, false);
  assert.equal(c('Bash', { command: 'cat README.md' }).gated, false, 'named in the prompt');
  assert.equal(c('Bash', { command: 'npm test' }).gated, false);
  assert.equal(c('Edit', { file_path: `${ANT}/a` }).gated, false, 'not a gated tool');
  const onlyRead = { ...ctx, cfg: cfg({ gatedTools: ['Read'] }) };
  assert.equal(classify(io, 'Bash', { command: 'rg foo' }, onlyRead).gated, false);
});
