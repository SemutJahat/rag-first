// End-to-end: the real hook process (scripts/gate.mjs) and log viewer, with a throwaway HOME and data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, '..', 'scripts', 'gate.mjs');
const LOG = join(HERE, '..', 'scripts', 'log.mjs');

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'rag-first-test-'));
  const proj = join(home, 'code', 'proj');
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(join(home, '.enowx-rag'), { recursive: true });
  writeFileSync(join(home, '.enowx-rag', 'project_dirs.json'), JSON.stringify({ proj: [proj] }));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'enowx-rag': { command: 'x' } } }));
  const env = { PATH: process.env.PATH, HOME: home, RAG_FIRST_DIR: join(home, 'data') };
  const run = (script, input, args = []) => spawnSync(process.execPath, [script, ...args], { input, env, encoding: 'utf8', timeout: 10000 });
  return { home, proj, env, run };
}

test('garbage on stdin: exit 0, no output (fail open), the error logged', () => {
  const { run, env } = setup();
  const r = run(GATE, 'not json');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const log = readFileSync(join(env.RAG_FIRST_DIR, 'gate.jsonl'), 'utf8');
  assert.match(log, /"decision":"error"/);
});

test('empty input object: exit 0, nothing printed', () => {
  const { run } = setup();
  const r = run(GATE, '{}');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('a whole prompt through the real process, then /rag-first:log and --summary', () => {
  const { run, proj } = setup();
  const ev = (o) => run(GATE, JSON.stringify({ session_id: 'abc12345-x', cwd: proj, ...o }));
  assert.equal(ev({ hook_event_name: 'UserPromptSubmit', prompt: 'how?' }).stdout, '');
  const d = JSON.parse(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rg foo' } }).stdout);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /project_id "proj"/);
  ev({ hook_event_name: 'PostToolUse', tool_name: 'mcp__enowx-rag__rag_semantic_search', tool_input: { project_id: 'proj', query: 'foo' } });
  assert.equal(ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rg foo' } }).stdout, '');
  const table = run(LOG, '').stdout;
  assert.match(table, /time\s+session\s+event/);
  assert.match(table, /abc12345\s+PreToolUse\s+Bash\s+deny\s+proj/);
  assert.match(table, /searched/);
  const sum = run(LOG, '', ['--summary']).stdout;
  assert.match(sum, /deny\s+1/);
  assert.match(sum, /prompts in indexed projects: 1 · with a RAG search: 1 · with a denial: 1/);
  assert.match(run(LOG, '', ['--session', 'zzz']).stdout, /no decisions yet .* for session zzz/);
});

test('log viewer with no log yet', () => {
  const { run } = setup();
  assert.match(run(LOG, '').stdout, /no decisions yet/);
});

test('hooks.json: every hook that sees the search tools also sees rag_index_project', async () => {
  const { readFileSync } = await import('node:fs');
  const h = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  for (const [ev, list] of Object.entries(h)) {
    for (const e of list) {
      if (e.matcher && e.matcher.includes('rag_retrieve_context')) assert.match(e.matcher, /rag_index_project/, ev);
    }
  }
});
