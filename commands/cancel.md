---
description: Cancel a running background agy job in this repository
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-runtime.mjs" cancel "$ARGUMENTS"`
