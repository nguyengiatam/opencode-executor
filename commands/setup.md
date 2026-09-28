---
description: Check whether the agy CLI is installed and has remaining quota
argument-hint: ''
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-runtime.mjs" setup --json
```

Present the result. If `installed` is false, tell the user to install the Antigravity CLI (`agy`) and ensure it is on PATH. Otherwise report `quota` and render `groups` as a table of group / window / remaining / reset time. `exhausted` means every model group is spent — tell the user the earliest reset time and suggest another executor meanwhile. `partial` means one group is spent — suggest `--model` to target the group that still has room. `ok` confirms agy is ready to receive tasks.
