---
description: Check whether the opencode CLI is installed and list available models
argument-hint: '[--json]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-runtime.mjs" setup --json
```

Present the result. Report `opencodePath`, `installed`, `version`, and the available `models` with their count. If `installed` is false, tell the user to install opencode and ensure it is on PATH.
