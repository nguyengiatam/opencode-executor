---
description: Show the stored output for an agy job in this repository
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-runtime.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve file paths, line numbers, and any error text exactly.
