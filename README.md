# agy-executor

A Claude Code plugin that dispatches the **Antigravity CLI (`agy`)** as a
background coding executor — with the correct flags baked in, per-repo job
tracking, quota checks, and resume. Modeled on the `codex` plugin's shape
(runtime + slash commands + forwarder subagent), minus the app-server machinery
agy doesn't need.

## Install

```
/plugin marketplace add https://github.com/nguyengiatam/agy-executor.git
/plugin install agy-executor@agy-executor-marketplace
```

## Requirements

The `agy` (Antigravity) CLI must be installed and on your PATH. Run
`/agy-executor:setup` to verify install and remaining quota.

## Commands

| Command | Purpose |
|---------|---------|
| `/agy-executor:exec <task>` | Dispatch a task to agy (background by default; `--wait` for inline). |
| `/agy-executor:status [id]` | List recent jobs, or show one job's detail + output tail. |
| `/agy-executor:result [id]` | Print a job's stored output (defaults to the latest). |
| `/agy-executor:cancel [id]` | Cancel a running background job. |
| `/agy-executor:quota` | Show remaining quota per model group, with reset times. |
| `/agy-executor:setup` | Check agy install + quota. |

Claude can also delegate to the `agy-executor:agy-runner` subagent, which
forwards a task to the runtime.

## Why a runtime wrapper

`agy` is easy to call wrong: passing the prompt positionally makes it research
the flag instead of doing the task, and an exhausted quota fails silently. The
runtime builds the command correctly every time and tracks jobs so you can poll
and resume. It also reads real quota from agy's own `/quota` command, so
`exec` refuses to dispatch into an exhausted account instead of producing a job
that exits 0 having done nothing. See the `agy-cli-runtime` skill for the full
contract.

## License

MIT.
