# T0023 test round 1: superseded status

**Verdict: pass.** All 21 acceptance scenarios hold. There are no failures to reproduce.

| Check | Result | Evidence |
|---|---|---|
| `bunx tsc --noEmit` | clean | `test-round-1/tsc.txt` |
| `bun test` | 77 pass, 0 fail (`test/superseded.test.ts` has 43) | `test-round-1/bun-test.txt` |
| End-to-end run (`test-round-1/e2e.sh`) | 78 checks pass, 0 fail | `test-round-1/e2e-output.txt` |
| `test/smoke.sh`, herdr shimmed out | all stages pass, "smoke test passed" | `test-round-1/smoke.txt` |

## How it was run

`e2e.sh` starts a real taskd with its own `FOREMAN_HOME` on port 7788 and drives it with `bin/task`. `test/fake-claude.sh` is the worker and `test/fake-linear.ts` is Linear. No model was called, and the live taskd and database were not touched.

To reproduce: `bash specs/t0023-superseded-status-task-close/qa/test-round-1/e2e.sh`. It exits non-zero if any check fails.

The run starts with `main`'s taskd, creates tasks, then restarts on this branch and closes one. That is the order the handoff gives for T0015.

## Scenarios

| # | Scenario | bun test | e2e |
|---|---|---|---|
| 1 | failed, cancelled, gate, blocked all close, with one event each | yes | yes |
| 2 | Open questions answered `(task superseded)` | yes | yes |
| 3 | Lease released, heartbeat returns `cancel: true` | yes | yes |
| 4 | Late result, including `blocked`: step failed, task stays superseded | yes | yes |
| 5 | `task block` from a superseded task's worker answered at once | yes | yes, real CLI |
| 6 | Tick adds no step | yes | yes, over real ticks |
| 7 | running, done, superseded refused | yes | yes |
| 7 | queued refused | yes | no, bun test only |
| 8 | Unknown, self, cycle refused | yes | yes |
| 9 | `task close` with no or empty value exits 1, no request | yes | yes, against a dead URL |
| 10 | `cancel` and `retry` refused | yes | yes |
| 11 | `--continues` closes a failed task, both events recorded | yes | yes |
| 12 | Unknown or running: no task, id or worktree created | yes | yes |
| 13 | `--branch --start-at --continues` adopts the worktree; the worker ran in it | yes | yes, real git |
| 14 | Dirty worktree, missing branch, bad `--start-at`: old task unchanged | yes (bad `--start-at`: e2e only) | yes |
| 15 | `--continues` with no value exits 1, no request (see observation 1) | yes | yes |
| 16 | Full `superseded→<id>`; with no superseded row, output is byte-identical to `main`'s CLI | yes | yes, compared with `main` |
| 17 | `task show` line under status; `--json` carries the field | yes | yes |
| 18 | `ls` and `inbox` leave out tasks closed from blocked and gate | yes | yes |
| 19 | One `Continued as <id>`, no transition; shared or no ticket silent | yes | yes, see `linear.log` |
| 20 | Provider down: still superseded, `ticket.error` recorded | yes | yes, fake Linear killed |
| 21 | Help documents `close` and `--continues` | yes | yes |

Display behaviour outside the numbered scenarios:

- **`foreman watch`:** the recent list shows `superseded→<id>` (`watch-raw.txt`). The implement step had not run this.
- **Dashboard, headless Chrome:** the header reads `1 failed · 13 superseded`, Recent shows the pointer, and no superseded task is under Needs you, while the failed task is (`dashboard.png`, `dashboard-dom.html`).

## Observations (none block the verdict)

1. **`--continues --branch x` reaches taskd.** The shared `opt()` parser reads the next flag as the value, so the CLI sends `continues: "--branch"`. taskd answers `no such task '--branch'`, the exit code is 1 and nothing is created. Scenario 15 is met when the flag has no following argument. `--superseded-by` uses the same parser. This matches every other option in the CLI, so no change is needed for this task.
2. **Foreman compares worktree paths without resolving symlinks.** With `worktrees` under macOS's `/var` symlink, adopting a worktree fails with "is checked out at /private/var/...". `--continues` then fails safely and the old task keeps its status. This code predates the branch and the default config does not hit it. The first e2e run failed on this, so the script now resolves its temp path.
3. **`--continues` output does not mention the close.** It prints only `created T0016 ...`. The spec does not ask for more.

## Limits of this run

- **herdr tabs were not driven.** herdr is shimmed to fail so the user's session stays untouched, and workers ran as background processes.
- **`smoke.sh` exited 1 after printing "smoke test passed".** This appears to come from the shim, not the branch: its cleanup trap parses `herdr workspace list` under `set -e`, and the `logs:` line that follows that parse never printed. It was not rerun with real herdr.
- **Worker kill not confirmed.** The heartbeat returned `cancel: true`, but the fake worker's `sleep 12` outlived the 5s lease, so that step's recorded error is `lease expired: runner stopped heartbeating`. The result arrived later and was ignored as late. A task cancelled in the same run logged the same late result, so this path is shared with cancel. The task stayed superseded throughout.
- **Some states were set by direct SQL on the isolated DB.** A real `failed` status, and a `blocked` task with a running step (as in parallel QA), are slow to produce with the fake worker.
- **`task close T0015 --superseded-by T0019` was not run.** The assistant runs it after the merge and restart.
