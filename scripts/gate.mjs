#!/usr/bin/env node
// rag-first command hook: UserPromptSubmit (reset), PreToolUse on Grep|Glob|Read|Bash (deny until searched),
// PostToolUse on the enowx-rag search tools (mark searched) and on Write|Edit (remember written files).
// Reads the hook input on stdin. Whatever happens it exits 0, and on any error it prints nothing: fail open.
import { decide, makeIO, writeLog } from './lib.mjs';

let raw = '';
try {
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const { output } = decide(input, makeIO());
  if (output) process.stdout.write(JSON.stringify(output));
} catch (e) {
  try { writeLog(makeIO(), { decision: 'error', reason: `hook error: ${e?.message || e}` }); } catch {}
}
process.exit(0);
