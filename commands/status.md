---
description: Show active and recent opencode jobs for this repository
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-runtime.mjs" status "$ARGUMENTS"`

If no job id was passed, render the output as a compact Markdown table. If a job id was passed, present the full detail including sessionID and the summary tail. Do not add prose beyond what the command returned.
