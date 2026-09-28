---
description: Show active and recent agy jobs for this repository
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-runtime.mjs" status "$ARGUMENTS"`

If no job id was passed, render the output as a compact Markdown table. If a job id was passed, present the full detail including the tail of the job output. Do not add prose beyond what the command returned.
