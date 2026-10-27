# Add `task log` command (T0002)

## Summary

Adds `task log <id> [step] [--attempt N] [--tail N] [--json]` to the Foreman CLI. It pretty-prints a step run's transcript, so you can read what a worker did without opening the raw JSONL. It uses the runner's live-view renderer, which now lives in a shared `src/pretty.ts`.

## What changed

- **`src/pretty.ts`** (new): `short` and `prettyEvent` moved here from `src/runner.ts` unchanged; the only edit is adding `export`.
- **`src/runner.ts`**: imports `prettyEvent` from `./pretty`. Its behaviour is unchanged.
- **`src/cli.ts`**: new `case "log"`.
  - Gets the task's steps from the existing `GET /tasks/:id`.
  - Picks a step: the named one, or the latest step row if no name is given.
  - Picks an attempt: `--attempt N`, or the step's highest attempt number by default.
  - Reads `RUNS_DIR/<task>/<step>-<attempt>/transcript.jsonl` from the local disk.
  - Renders each event with `prettyEvent`. Lines that aren't valid JSON are printed as-is, as the runner does.
  - `--json` prints the raw lines. `--tail N` keeps only the last N rendered lines.
  - `--attempt` and `--tail` must be positive integers.
  - If there's no id, no steps, an unknown step, an unknown attempt or no transcript file, it prints a one-line `error:` and exits 1.
  - `TASK_HELP` lists the command.
- **`README.md`**: one new line in the Use section.
- **`specs/t0002-add-task-log-command/`**: spec, plan, tasks and QA reports.

Not touched: taskd's HTTP API, the database schema, `test/`, `prompts/`, dependencies.

## How it was verified

Verification mode is *inspect*: commands were run against real run data in `~/.foreman/runs/T0001`, plus the typecheck.

- **Review:** [qa/review-round-1.md](qa/review-round-1.md). Verdict: pass, with two optional findings (see Follow-ups).
- **Acceptance test:** [qa/test-round-1.md](qa/test-round-1.md). All 11 spec scenarios pass; evidence is in [qa/test-round-1/](qa/test-round-1/).
  - The CLI's output for T0001 research-1, -2 and -3 is **byte-identical** to the old in-runner `prettyEvent` (taken from 6b13085), so the refactor doesn't change rendering.
  - The missing-transcript, no-steps and invalid-JSON scenarios aren't covered by T0001's data. They were run against a stub taskd with a temp `FOREMAN_HOME`.
- `bunx tsc --noEmit` passes. It was run again on this branch for this PR.
- `git merge-tree` against current `main` shows no conflicts. Since the branch was cut, main has only gained e300ca9, a one-line change in `src/taskd.ts`.

## Merge risk: **low**

- The new command only reads data. It calls an existing endpoint and reads files locally. Nothing on the server side or in the schema changed.
- The one change to an existing path is moving `prettyEvent` out of the runner. That move is verbatim, and the test step showed the output is byte-identical.
- The branch merges cleanly with `main`.

## Follow-ups (optional, non-blocking)

1. **Default attempt rule (review F1):** the default is the highest attempt *number*, as the spec asks. taskd's `latestStep` uses the highest row id instead. On T0001's older data, where attempt numbers restarted at 1, `task log T0001` shows the failed research-3 run rather than the newest run. For tasks created now the two rules agree, because taskd always increments attempts. If we want the CLI to match taskd exactly, we could switch to "last row for that step".
2. **Flag with no value (review F2):** `--attempt` or `--tail` with no value is silently ignored. That's how `opt()` behaves everywhere in the CLI, so fixing it belongs in `opt()` for the whole CLI, not just this command.
3. No automated tests were added, because the brief ruled out touching `test/`. A smoke scenario for `task log` could go in later.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
