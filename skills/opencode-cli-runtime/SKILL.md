---
name: opencode-cli-runtime
description: Use when invoking or debugging the opencode CLI as a headless coding executor — documents the verified invocation, JSONL events, job statuses, timeout, and resume contract.
---

# opencode CLI Runtime Contract

`opencode` is used here as a headless coding executor. The runtime invokes it with JSONL output and explicit repository scope.

## Correct invocation

```text
opencode run --format json --auto --dir <repo> [-m provider/model] [-s <sessionID>] -- "<full task text>"
```

- `--auto` is required for headless execution so tool permissions are auto-approved.
- `--dir <repo>` is the repository root.
- The task is one positional argument after `--`; this also safely handles tasks beginning with `-`.
- stdin is ignored/closed.
- Without `-m`, opencode uses its configured default model. Never hardcode a model.
- opencode has no built-in timeout or capacity-check command.

## Runtime controls

| Flag | Meaning |
|------|---------|
| `--background` | Dispatch in the background; default. |
| `--wait` | Run synchronously and wait for completion. |
| `--resume` | Resume the latest repository job with a stored sessionID. |
| `--fresh` | Do not resume an existing session. |
| `--model <provider/model>` | Select the opencode model. |
| `--timeout <dur>` | Runtime timeout; default `85m`. Accepts `90s`, `30m`, `2h`, etc. |

`--resume` without `--fresh` passes `-s <sessionID>`. If no job in this repository has a sessionID, nothing is dispatched.

## Task recording and output

The full task is recorded in `jobDir/prompt.md` and also passed directly to opencode as the positional task argument.

- stdout → `jobDir/output.jsonl`
- stderr → `jobDir/stderr.log`

The first JSON event containing `sessionID` supplies the job sessionID. Background jobs resolve it lazily during status/result/refresh.

## JSONL events

Every event contains `type`, `timestamp`, and `sessionID`. Relevant event types include:

- `step_start`
- `tool_use` — tool name is in `part.tool`; completed calls include input such as `filePath` or `command`.
- `step_finish` — successful final completion has `part.reason: "stop"`.
- `text` — model reply is in `part.text`.
- `error` — failure details are under `error`, commonly `error.data.message`.

## Job statuses

Finished-job status is derived from the JSONL output rather than merely from process exit:

- `failed` — an `error` event exists; wait mode also treats a non-zero exit code as failed.
- `empty` — no JSONL events were produced.
- `finished` — the last `step_finish` has reason `stop`.
- `incomplete` — the process died without an error event or final `step_finish`.
- `timeout` — runtime timeout terminated the process.

Wait mode exits with code 1 for every status other than `finished`.

## Timeout

Wait mode uses the process spawn timeout. Background jobs are checked during status/result refresh; when `now > timeoutAt`, the runtime sends `SIGTERM` to the process group, falling back to the process PID.

## Resume

`-s <sessionID>` continues the same opencode session with its existing memory. `node scripts/opencode-runtime.mjs resume-candidate` reports the latest job that has a sessionID.

## Plugin commands

Use `/opencode-executor:exec`, `/opencode-executor:status`, `/opencode-executor:result`, `/opencode-executor:cancel`, and `/opencode-executor:setup`. There is no built-in capacity check.
