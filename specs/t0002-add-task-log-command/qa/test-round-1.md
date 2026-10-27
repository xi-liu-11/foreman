# T0002 test round 1 — `task log`

**Verdict: PASS** — all 11 acceptance scenarios pass. No failures.

Mode: inspect. Commands were run with this worktree's `./bin/task` (the `task` on PATH
points at the main checkout) against the live taskd and the real `~/.foreman/runs/T0001`.
Scenarios that need data T0001 doesn't have (7, 8, 10) were run against a small stub taskd
(`test-round-1/stub-taskd.ts.txt`) with `FOREMAN_URL`/`FOREMAN_TOKEN` and a temp `FOREMAN_HOME`.
Evidence files are in `test-round-1/`.

| # | Scenario | Result | Evidence |
|---|----------|--------|----------|
| 1 | `task log T0001` → latest step's latest attempt (research-3), ends with `[result]` | PASS — prints `[result] error_during_execution turns=0 cost=$0.000`, exit 0 | s01-latest.txt |
| 2 | `--attempt 1` renders research-1 identical to the runner | PASS — 50 lines with init, `▶` hints, `✗ tool error:`, `[result]`. Byte-identical to the **pre-refactor** runner `prettyEvent` (taken from commit 6b13085) for research-1/2/3. `src/pretty.ts` bodies match the removed runner code exactly, apart from `export` | s02-research-a1.txt, s02-runner-equivalence.txt, render-old.ts.txt |
| 3 | `--json` piped to `jq -c .type` | PASS — both exit 0 | s03-json-jq.txt |
| 4 | `--tail 5` prints exactly 5 rendered lines | PASS — 5 lines; the multi-line Bash hint is split on `\n` as the spec says | s04-tail5.txt |
| 5 | unknown step name | PASS — `error: no step 'nosuchstep' on T0001`, exit 1 | s05-nosuchstep.txt |
| 6 | `--attempt 9` | PASS — `error: no attempt 9 of step 'research' on T0001`, exit 1 | s06-attempt9.txt |
| 7 | step row exists, transcript missing | PASS — `error: no transcript at <path>` on one line, exit 1 | s07-missing-transcript.txt |
| 8 | task with no steps | PASS — `error: T0097 has no steps yet`, exit 1 | s08-no-steps.txt |
| 9 | no id | PASS — `error: task id required`, exit 1 | s09-noid.txt |
| 10 | invalid JSON lines printed verbatim | PASS — also correct with `--tail` and `--json` | s10-*.txt |
| 11 | `task help` lists `task log`; `bunx tsc --noEmit` | PASS — exit 0 | s11-help.txt, s11-tsc.txt |

Extra checks (sx-*.txt): `--tail 0` gives `error: --tail must be a positive integer` (exit 1).
`--json --tail 2` returns the last 2 raw events. An unknown task gives `error: no such task`
(exit 1). The diff against main touches only `README.md`, `src/cli.ts`, `src/pretty.ts`,
`src/runner.ts` and the spec files. There are no changes to taskd, the database schema,
`test/` or `prompts/`.

Observations (not failures):
- T0001's step list has a later `research #1 done` row, created by `/retry`, which restarted
  at attempt 1 (research report R8). With no `--attempt`, the CLI picks the highest attempt
  number (3), as the spec expects (scenario 1 says "research-3 today"). It is not the
  chronologically latest run. `research-1/transcript.jsonl` contains both runs appended
  together. This is a known taskd behaviour, not something this branch introduced.
- Output always includes ANSI colour codes, even when piped. This matches the runner, and
  colour toggling is out of scope.

## Reproduce
```sh
cd <worktree>
./bin/task log T0001
./bin/task log T0001 research --attempt 1
./bin/task log T0001 --json | jq -c .type
./bin/task log T0001 research --attempt 1 --tail 5
./bin/task log T0001 nosuchstep; echo $?
./bin/task log T0001 research --attempt 9; echo $?
./bin/task log; echo $?
bunx tsc --noEmit
```
For scenarios 7, 8 and 10: start `bun stub-taskd.ts` (saved here as `stub-taskd.ts.txt`) and
export `FOREMAN_URL=http://127.0.0.1:<port> FOREMAN_TOKEN=x FOREMAN_HOME=<tmp>`. Put
`<tmp>/runs/T0098/build-1/transcript.jsonl` in place with some non-JSON lines. Then run
`task log T0098 missing`, `task log T0097` and `task log T0098 build`.
