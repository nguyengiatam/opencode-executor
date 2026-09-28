---
name: agy-cli-runtime
description: Use when invoking or debugging the agy (Antigravity) CLI as a coding executor — documents the correct flags, prompt-handoff rule, quota check, and the failure modes that make agy silently do nothing.
---

# agy CLI Runtime Contract

`agy` is the Antigravity CLI, used here as a headless coding executor. It is easy
to invoke WRONG in a way that looks like success but does nothing. The
`agy-runtime.mjs` companion builds the command correctly; this skill is the
source of truth for why.

## The one rule that matters most

**Bind the prompt to `--print=` (or `--prompt=`). Never pass it positionally.**
`agy` has no positional prompt argument. A positional string gets swallowed and
agy goes off "researching" it instead of doing the task — the classic silent
failure. Correct:

```
agy --print="<instruction>" --dangerously-skip-permissions ...
```

`--print`, `-p`, and `--prompt` are the same flag (single-shot, non-interactive).

## Prompt handoff

Inline long prompts make agy return empty. Write the task to a file and make the
`--print=` value a short instruction that points at it:

```
agy --print="Read the task in /path/prompt.md and complete it." --add-dir /path ...
```

Always `--add-dir` the directory holding the prompt file so agy can read it.

## Correct flags (verified via `agy --help`)

| Flag | Meaning |
|------|---------|
| `--print=<text>` / `-p` / `--prompt=<text>` | Single-shot non-interactive prompt (value-taking). |
| `-c` / `--continue` | Continue the most recent conversation. |
| `--conversation <id>` | Resume a specific conversation by id. |
| `--dangerously-skip-permissions` | Auto-approve tool permissions (required headless). |
| `--mode accept-edits` | Let agy apply edits (use for an executor; `plan` is read-only planning). |
| `--add-dir <dir>` | Add a directory to the workspace (repeatable). |
| `--model "<name>"` | Pick the model, e.g. `"Claude Sonnet 4.6 (Thinking)"`. |
| `--print-timeout <dur>` | Wait timeout for print mode (default `5m`; use e.g. `85m` for multi-step work). |
| `--sandbox` | Opt-in terminal restrictions. Leave OFF for an executor. |

Run agy from the repo working directory. On WSL, run it with the Bash sandbox
disabled (`dangerouslyDisableSandbox: true`) so it can reach the filesystem and
network.

## Quota

agy can exhaust its quota and then **fail silently**: it prints a line or two of
preamble, exits 0, and produces near-empty output — looking like "ran but did
nothing."

Do NOT probe this by sending a throwaway prompt: that spends the very quota you
are measuring. agy has a `/quota` slash command (alias `/usage`), slash commands
are expanded in print mode, and it costs **zero model tokens**
(`usage.total_tokens == 0`). It also needs no `--dangerously-skip-permissions`:

```
agy --print="/quota" --output-format json --print-timeout 1m
```

The payload lands under `command.data.groups[]`, each with `buckets[]` carrying
`window` (`weekly` / `5h`), `remaining_fraction` (0..1) and `reset_time` (ISO
8601). Without `--output-format json` the same data prints as 4-column TSV
(group, metric, remaining %, reset).

Quota is per model *group*, not global — `Gemini Models` and
`Claude and GPT models` are spent independently, so one group hitting 0 still
leaves the other usable via `--model`. Each group has both a weekly limit tied
to your tier and a rolling 5-hour limit.

`/agy-executor:quota` renders this, `/agy-executor:setup` includes it, and
`/agy-executor:exec` runs it as a pre-flight and refuses to dispatch when every
group is spent (bypass with `--no-quota-check`).

## Failure modes checklist

- Empty/near-empty output on exit 0 → suspect quota exhaustion, not success. Confirm with `/quota`, never with a throwaway prompt.
- agy explaining a flag instead of doing the task → the prompt was positional.
- Empty output with a long inline prompt → hand the prompt off via a file.
- Cannot read the prompt file → its directory was not passed with `--add-dir`.

## How this plugin uses it

`/agy-executor:exec` (or the `agy-runner` subagent) builds all of the above
automatically. Prefer them over hand-typing agy. Use `/agy-executor:status`,
`:result`, and `:cancel` to manage background jobs, `/agy-executor:quota` to read
remaining quota and reset times, and `/agy-executor:setup` to verify install +
quota first.
