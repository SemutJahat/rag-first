---
description: Show rag-first's last gate decisions (reset, deny, searched, allow, exempt, let-through, off)
argument-hint: "[N] [--summary]"
allowed-tools: Bash(node:*)
---
rag-first's gate log (latest last):

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/log.mjs" $ARGUMENTS`

Show the output above to the user exactly as printed, inside a code block, and add nothing else: no summary, no commentary.
