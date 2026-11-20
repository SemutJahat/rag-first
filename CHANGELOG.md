# Changelog

## 0.2.1

- The PostToolUseFailure and PermissionDenied hooks now also match `rag_index_project`, so a refused or
  failed index call opens the gate at once with its own line (0.2.0 only caught it on the next held call).

## 0.2.0

- **New projects get indexed** (`indexNew`, on by default). In a git project that isn't in
  `~/.enowx-rag/project_dirs.json` yet, the gate used to switch itself off for the session, so a new project
  could run for hours without ever reaching enowx-rag. Now every prompt asks the model to call
  `rag_index_project` (project_id and directory spelled out), Grep/Glob/Read/search-like Bash are held until it
  succeeds, and then the normal search gate takes over. A refused, failed or unfinished index call lets the tools
  through for the prompt; without the enowx-rag MCP server it stays off as before. The hooks module pins
  `rag_index_project` in such a project. `"indexNew": false` restores the old behaviour.

## 0.1.0

- First version: the gate (UserPromptSubmit reset, PreToolUse deny on Grep/Glob/Read and search-like Bash
  until an enowx-rag search, PostToolUse mark), strict / nudge / off modes, display all / changes / off, loop
  guard, fail-open on refused or failed searches, exemptions (outside the project, named in the prompt, written
  this session, non-text), automatic off-switches (enowX session, not a code project, not indexed, MCP server
  not in the session, any error), tool pinning through a `tool.describe` hooks module, `/rag-first:log`.
