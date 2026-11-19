# Changelog

## 0.1.0

- First version: the gate (UserPromptSubmit reset, PreToolUse deny on Grep/Glob/Read and search-like Bash
  until an enowx-rag search, PostToolUse mark), strict / nudge / off modes, display all / changes / off, loop
  guard, fail-open on refused or failed searches, exemptions (outside the project, named in the prompt, written
  this session, non-text), automatic off-switches (enowX session, not a code project, not indexed, MCP server
  not in the session, any error), tool pinning through a `tool.describe` hooks module, `/rag-first:log`.
