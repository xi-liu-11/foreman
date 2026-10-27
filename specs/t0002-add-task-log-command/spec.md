# Add task log command

_Created by Foreman T0002._

## Goal

Let a user read what a worker did in a step without opening the raw
`transcript.jsonl`: `task log <task-id> [step-name]` pretty-prints a step run's
transcript using exactly the same rendering as the runner's live view.

## Scope

- New `task log` subcommand in `src/cli.ts`:
  - `task log <id>` — latest attempt of the task's latest step (the last row
    returned by `GET /tasks/:id` `steps`, which taskd orders by step id).
  - `task log <id> <step-name>` — latest attempt of the named step.
  - `--attempt N` — that attempt of the selected step (with or without a name;
    without a name it applies to the latest step's name).
  - `--json` — print the raw transcript events (one JSON object per line, as
    stored) instead of rendered output.
  - `--tail N` — print only the last N rendered lines (lines after splitting
    multi-line rendered events on `\n`). With `--json`, the last N events.
- Transcript path: `RUNS_DIR/<task>/<step>-<attempt>/transcript.jsonl`
  (`RUNS_DIR` from `src/config.ts`). Read locally; taskd is only used for the
  step list.
- Move `prettyEvent` (and its helper `short`) out of `src/runner.ts` into a new
  `src/pretty.ts`; runner imports it. Runner output is byte-for-byte unchanged.
- `task help` lists the command; README "Use" section gets one line.

## Acceptance scenarios

1. `task log T0001` prints the rendered transcript of T0001's latest step's
   latest attempt (`research-3` today), ending with a `[result] …` line if the
   run produced one.
2. `task log T0001 research --attempt 1` renders `research-1/transcript.jsonl`:
   assistant text, `▶ Tool hint` lines, `✗ tool error:` lines, `[result]` line —
   identical to what the runner printed live.
3. `task log T0001 --json` prints raw JSONL lines; piping to `jq -c .type` works.
4. `task log T0001 research --attempt 1 --tail 5` prints exactly the last 5
   rendered lines.
5. `task log T0001 nosuchstep` → `error: no step 'nosuchstep' on T0001`,
   exit 1.
6. `task log T0001 research --attempt 9` → `error: no attempt 9 of step
   'research' on T0001`, exit 1.
7. A step row exists but its transcript file is missing →
   `error: no transcript at <path>`, exit 1 (one line).
8. A task with no steps yet → `error: T000X has no steps yet`, exit 1.
9. `task log` with no id → `error: task id required`, exit 1.
10. Lines in the transcript that are not valid JSON are printed verbatim (same
    as the runner does live).
11. `task help` shows the `task log` line; `bunx tsc --noEmit` passes.

## Out of scope

- Any change to taskd's HTTP API or the SQLite schema.
- Following a live transcript (`-f`), colour toggling, paging.
- Fetching transcripts remotely (runs on other machines).
- Changes to `test/` or `prompts/`.
- New dependencies.
