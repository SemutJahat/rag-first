// rag-first's hooks module: loads the two enowx-rag search tools up front instead of behind ToolSearch.
//
// Why: with the MCP tools deferred, the model has to call ToolSearch before it can search the RAG, and the
// benchmark's soft rule ("use RAG first") was ignored 24 times out of 24 with Grep one call away. The benchmark
// loaded the schemas up front with `--tools Read,Grep,Glob,Bash`, which also removes every other built-in tool.
// A `tool.describe` hook answering `isDeferred: false` puts just these two tools' schemas in the prompt and leaves
// every other tool where it was. Only when the gate is on for the folder (scripts/pin.mjs decides, once per
// session) and `pinTools` is true. The gate itself is the command hooks in hooks.json.
import type { Register } from 'claude-code'

const PIN = /^mcp__enowx-rag__rag_(retrieve_context|semantic_search)$/

// Once per session process (a module reload asks again).
let verdict: Promise<{ pin?: boolean }> | undefined

async function decide($: any): Promise<{ pin?: boolean }> {
  try {
    let cwd: string | undefined
    let sessionId: string | undefined
    try { cwd = await $.session.cwd() } catch {}
    try { sessionId = await $.session.id() } catch {}
    const r = await $.process.run(['node', `${$.plugin.root}/scripts/pin.mjs`], {
      stdin: JSON.stringify({ cwd, session_id: sessionId }),
      timeoutMs: 5000,
    })
    return r.exitCode === 0 ? JSON.parse(r.stdout || '{}') : {}
  } catch {
    return {}
  }
}

export const register: Register = on => {
  on('tool.describe', { tool: /^mcp__enowx-rag__/ }, async ($, e, next) => {
    const r = await next(e)
    verdict ??= decide($)
    const v = await verdict
    return PIN.test(e.tool) && v.pin ? { ...r, isDeferred: false } : r
  // If anything above throws, the tool keeps the engine's placement.
  }).catch(($, e, next) => next(e))
}
