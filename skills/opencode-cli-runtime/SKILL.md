---
name: opencode-cli-runtime
description: Use when invoking or debugging the opencode CLI as a headless coding executor — documents the verified invocation, JSONL events, job statuses, timeout, and resume contract.
---

# opencode CLI Runtime Contract

`opencode` is used here as a headless coding executor. The runtime invokes it with JSONL output and explicit repository scope.

## Correct invocation

```text
opencode run --format json --auto --standalone [-m provider/model] [-s <sessionID>] -- "<full task text>"
```

- `--auto` is required for headless execution so tool permissions are auto-approved.
- Run from the repository root (the runtime spawns opencode with `cwd` = repo). opencode 2.x removed `--dir` (`Unrecognized flag: --dir`); `--standalone` runs a private server in that directory instead of the shared background service.
- The task is one positional argument after `--`; this also safely handles tasks beginning with `-`.
- stdin is ignored/closed.
- Without `-m`, opencode uses its configured default model. Never hardcode a model.
- opencode has no built-in timeout or capacity-check command.
- `opencode models` asks the background service; a just-started server has not loaded its provider catalog yet and returns an empty list with exit 0 for about the first second. `setup` retries (up to ~6s) until models appear. `opencode models --standalone` is always empty for the same reason — do not use it.

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
- `tool_use` — tool name is in `part.tool`; input is in `part.state.input` (opencode 2.x uses `path` for files, 1.x used `filePath`; shell calls use `command`). A `question` tool call means opencode stopped to ask the user something.
- `step_finish` — successful final completion has `part.reason: "stop"`.
- `text` — model reply is in `part.text`.
- `error` — details under `error`: opencode 2.x uses `error.type` (`provider.quota`, `provider.auth`, `provider.internal`, `provider.invalid-output`, …) and `error.message`; 1.x used `error.data.message`. opencode 2.x also emits `error` for transient provider failures (504, stream cut off) that it retries itself — the run continues afterwards, so an `error` event alone does not mean the job failed.

## Job statuses

Finished-job status is derived from the JSONL output rather than merely from process exit:

- `failed` — the last `error` event is not followed by any progress (`text`, `tool_use`, `step_finish`), or opencode exited non-zero. `errorType` records `error.type`; `provider.quota` means rate-limited/out of quota — wait, then `--resume`.
- `empty` — no JSONL events were produced.
- `needs_input` — the run ended on a `question` tool call (opencode asked the user something it cannot get headless). `result` prints the question and options; answer by dispatching again with `--resume`.
- `finished` — the last `step_finish` has reason `stop`, or (opencode 2.x, which emits no final `step_finish`) the process exited 0 and the last event is `text`. Earlier transient errors it recovered from are reported but do not fail the job.
- `incomplete` — the process died without a fatal error, a question, or a final answer.
- `timeout` — runtime timeout terminated the process.
- `cancelled` — stopped with `cancel`.

Background jobs run under `/bin/sh -c '"$0" "$@"; echo $? > exit_code'` so opencode's exit code lands in `jobDir/exit_code` (the shell is the process-group leader, so cancel/timeout still stop opencode). opencode 2.x exits 1 on a fatal error.

Wait mode exits with code 1 for every status other than `finished`.

## Timeout

Wait mode uses the process spawn timeout. Background jobs are checked during status/result refresh; when `now > timeoutAt`, the runtime sends `SIGTERM` to the process group, falling back to the process PID.

## Resume

`-s <sessionID>` continues the same opencode session with its existing memory. `node scripts/opencode-runtime.mjs resume-candidate` reports the latest job that has a sessionID.

## Plugin commands

Use `/opencode-executor:exec`, `/opencode-executor:status`, `/opencode-executor:result`, `/opencode-executor:cancel`, and `/opencode-executor:setup`. There is no built-in capacity check.
