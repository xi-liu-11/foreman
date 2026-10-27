# Review round 1 — T0002 task log command

Verdict: **pass** (no blocking findings; two minor, optional follow-ups below).

Reviewed `git diff main...HEAD` (README.md, src/cli.ts, src/pretty.ts, src/runner.ts)
against spec.md, plan.md and the task brief.

## Checks performed

- `bunx tsc --noEmit` — passes.
- `src/pretty.ts` vs. the removed block in `src/runner.ts`: `short` and `prettyEvent`
  are byte-identical (same ANSI codes, `n = 160` default, 140/200 truncation). Runner
  only gains `import { prettyEvent } from "./pretty"`; its call site (runner.ts:126)
  and the "print non-JSON lines verbatim" behaviour are unchanged.
- Scope: no changes to test/, prompts/, taskd HTTP API, or DB schema; no new deps.
- Live run against T0001 (taskd up):
  - `task log T0001` → `[result] error_during_execution turns=0 …` (research-3), rc 0. Matches scenario 1.
  - `task log T0001 research --attempt 1` → full rendering with `▶` lines and one `[result]` line.
  - `--attempt 1 --tail 5 | wc -l` → 5. `--json --attempt 1 | jq -c .type` works.
  - `nosuchstep` → `error: no step 'nosuchstep' on T0001`, rc 1.
  - `--attempt 9` → `error: no attempt 9 of step 'research' on T0001`, rc 1.
  - `--tail 0` / `--tail abc` → `error: --tail must be a positive integer`, rc 1.
  - no id → `error: task id required`, rc 1.
  - `FOREMAN_HOME=$(mktemp -d) task log T0001` → `error: no transcript at …/runs/T0001/research-3/transcript.jsonl`, rc 1.
  - `task help` lists `task log`; README Use has one new line.
- Path uses `d.task.id` and `<name>-<attempt>`, matching `runDirFor` in taskd.ts:38 and runner.ts:24.

## Findings (non-blocking)

### F1 — default attempt is max(attempt), not the most recent row
- File: `src/cli.ts`, line 146 (`Math.max(...named.map(s => s.attempt))`)
- Failure scenario: T0001's step rows are `research #1 failed, #2 failed, #3 failed,
  #1 done` (attempt numbers reset under pre-hardening taskd code). `task log T0001`
  shows research-3 — a one-line failed run — rather than the most recent run, which
  is the successful one the user wants to read. taskd itself defines "latest" as the
  highest row id (`db.ts:209` `latestStep … ORDER BY id DESC`), so the CLI and the
  scheduler disagree about which attempt is latest whenever attempt numbers aren't
  monotonic. Current taskd always increments attempts, so the two rules agree for new
  tasks. The spec explicitly picks max(attempt) ("`research-3` today"), so this follows
  the spec and doesn't block.
- Suggested change (optional): use `named[named.length - 1].attempt` (steps arrive
  ordered by id ASC, `db.ts:206`) so that `task log` agrees with `latestStep`. If you
  make this change, update spec scenario 1 to match.

### F2 — `--attempt` / `--tail` with no value are silently ignored
- File: `src/cli.ts`, lines 133–136 (`posInt` → `opt`)
- Failure scenario: `task log T0001 --attempt` (value forgotten) prints the default
  attempt with rc 0 instead of an error, because `opt()` returns `undefined` when the
  flag is the last argument. This is the existing behaviour of `opt()` across the CLI,
  so it's consistent with the codebase. It's a usability nit, not a defect.
- Suggested change (optional): in `posInt`, if `flag(name)` is set and `opt(name)` is
  undefined, `die(\`--${name} requires a value\`)`.

## Out-of-scope observation

`~/.foreman/runs/T0001/research-1/` is shared by two different step rows (the
attempt-number reset), so one run's artifacts overwrote or were appended to the other's.
This comes from legacy data, not from this change. Mentioned only so it isn't
mistaken for a `task log` bug.
