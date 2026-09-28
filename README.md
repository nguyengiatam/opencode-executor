# opencode-executor

A Claude Code plugin that dispatches the **opencode CLI** as a background coding executor — with the correct flags baked in, per-repo job tracking, timeout handling, and session resume.

## Install

```
/plugin marketplace add https://github.com/nguyengiatam/opencode-executor.git
/plugin install opencode-executor@opencode-executor-marketplace
```

## Requirements

The `opencode` CLI must be installed and on your PATH. Run `/opencode-executor:setup` to verify the installation and list available models.

## Commands

| Command | Purpose |
|---------|---------|
| `/opencode-executor:exec <task>` | Dispatch a task to opencode (background by default; `--wait` for inline). |
| `/opencode-executor:status [id]` | List recent jobs, or show one job's detail, sessionID, and output-event summary. |
| `/opencode-executor:result [id]` | Print a job's human-readable result (`--raw` for stored JSONL). |
| `/opencode-executor:cancel [id]` | Cancel a running background job. |
| `/opencode-executor:setup` | Check opencode installation, version, and available models. |

## Runtime

The runtime invokes opencode as:

```
opencode run --format json --auto --dir <repo> [-m provider/model] [-s <sessionID>] -- "<full task text>"
```

`--background` is the default; `--wait` runs synchronously. Runtime timeout defaults to `85m` and accepts durations such as `90s`, `30m`, and `2h`. Resume continues an existing opencode session with `-s <sessionID>`; `--fresh` starts without resuming.

Job stdout is stored as JSONL and stderr separately. Completion is derived from the JSONL events: `finished`, `failed`, `empty`, `incomplete`, or `timeout`.

See the `opencode-cli-runtime` skill for the full contract.

## License

MIT.
