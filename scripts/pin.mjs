#!/usr/bin/env node
// Helper of the hooks module (hooks/register.ts), which has no Node of its own and runs this with $.process.run.
//   stdin {cwd, session_id}  ->  stdout {"pin": true|false, ...}
// Always exits 0 and prints JSON; on any error {"pin": false}.
import { pinDecision, makeIO } from './lib.mjs';

let out = { pin: false };
try {
  let s = '';
  for await (const c of process.stdin) s += c;
  out = pinDecision(JSON.parse(s || '{}'), makeIO());
} catch (e) {
  out = { pin: false, error: String(e?.message || e) };
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
