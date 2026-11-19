#!/usr/bin/env bash
# One real headless Claude Code session with rag-first loaded from this folder, nothing installed:
#   test/real-run.sh WORK_DIR RUN_DIR PROMPT
# PERMISSION_MODE (default, acceptEdits, auto, bypassPermissions) picks the mode; MAIN_MODEL (default sonnet),
# EFFORT (default low). --setting-sources "" reads no settings files (so none of your other plugins or hooks),
# and then no MCP servers load from ~/.claude.json either: MCP_CONFIG (a --mcp-config file) names the servers;
# unset, the session has none (the gate must then stay off). Write tools are denied, so WORK_DIR is
# only read. ENOWX_SESSION is unset (inside enowX the gate is off by design). The gate's log and state go to
# RUN_DIR/log; the stream (with hook events) to RUN_DIR/stream.jsonl.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$1"; RUN="$2"; PROMPT="$3"
mkdir -p "$RUN/log"
cd "$WORK"
env -u ENOWX_SESSION RAG_FIRST_DIR="$RUN/log" claude -p --plugin-dir "$ROOT" --setting-sources "" \
  ${PERMISSION_MODE:+--permission-mode "$PERMISSION_MODE"} \
  ${MCP_CONFIG:+--mcp-config "$MCP_CONFIG" --strict-mcp-config} \
  --model "${MAIN_MODEL:-sonnet}" --effort "${EFFORT:-low}" \
  --disallowedTools Edit Write NotebookEdit Agent Task mcp__enowx-rag__rag_index mcp__enowx-rag__rag_index_project \
    mcp__enowx-rag__rag_delete_points mcp__enowx-rag__rag_delete_project mcp__enowx-rag__rag_create_project \
  --output-format stream-json --verbose --include-hook-events -- "$PROMPT" \
  < /dev/null > "$RUN/stream.jsonl" 2> "$RUN/stderr.txt" || echo "claude exited $?" >> "$RUN/stderr.txt"
