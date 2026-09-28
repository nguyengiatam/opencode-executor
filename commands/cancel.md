---
description: Cancel a running background opencode job in this repository
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-runtime.mjs" cancel "$ARGUMENTS"`
