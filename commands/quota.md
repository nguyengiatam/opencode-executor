---
description: Show agy's remaining quota per model group, with reset times
argument-hint: '[--json]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-runtime.mjs" quota $ARGUMENTS`

Present the table as-is. The `verdict` line is the headline: `ok` means agy can take work, `partial` means one model group is spent (suggest `--model` to target the group that still has room), `exhausted` means every group is spent and the user should wait for the earliest reset shown or switch executor. Do not re-order or summarize the table rows.
