---
description: Dispatch a coding task to the opencode CLI as a background or foreground executor
argument-hint: "[--wait|--background] [--resume|--fresh] [--model <provider/model>] [--timeout <dur>] <task>"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-runtime.mjs" exec $ARGUMENTS`

Present the command output verbatim. If a background job was dispatched, tell the user the job id and the `/opencode-executor:status <id>` and `/opencode-executor:result <id>` follow-ups. Do not summarize opencode's output when `--wait` was used — show it as-is.
