---
description: Show the stored output for an opencode job in this repository
argument-hint: '[job-id] [--raw]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-runtime.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve file paths and error text exactly.
