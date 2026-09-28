---
description: Dispatch a coding task to the agy (Antigravity) CLI as a background or foreground executor
argument-hint: "[--wait|--background] [--resume|--fresh] [--model <name>] [--add-dir <dir>] [--timeout <dur>] <task>"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-runtime.mjs" exec $ARGUMENTS`

Present the command output verbatim. If a background job was dispatched, tell the user the job id and the `/agy-executor:status <id>` and `/agy-executor:result <id>` follow-ups. Do not summarize agy's output when `--wait` was used — show it as-is.
