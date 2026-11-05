# T0058 test round 1: pass

Mode: inspect. Branch `fm/t0058-dashboard-recent-shows-newest` at 54eaa28. No device or e2e matrix applies here: Foreman is a single Bun daemon plus a static dashboard.

## Automated suite
| Check | Result | Evidence |
|---|---|---|
| `bunx tsc --noEmit` | clean | `test-round-1/tsc.txt` |
| `bun test` | 211 pass, 0 fail, 20 files (4 of them in `test/dashboard-recent.test.ts`) | `test-round-1/bun-test.txt` |
| `sh test/smoke.sh` | pass (run 2 with clean env) | `test-round-1/smoke-clean-env-run2.txt` |

Smoke notes. Neither failure is caused by this branch, which only changes `src/dashboard.html`.
- `smoke-with-worker-env.txt`: failed at "no start transition" because the worker's `FOREMAN_TASK` / `FOREMAN_STEP` / `FOREMAN_HOME` vars leaked into the `task` CLI calls ("error: project (or task) required"). This is a test-harness artifact of running smoke inside a Foreman step. Re-run with every `FOREMAN_*` var unset: `env -u FOREMAN_TASK -u FOREMAN_STEP ... sh test/smoke.sh`.
- `smoke-clean-env-run1.txt`: the timing-sensitive "taskd outage longer than the lease" check failed with "expected 1 attempt, got 2". The same check passed in the first run and in run 2, so it is a flake.

## Acceptance scenarios
| # | Scenario | Result | How verified |
|---|---|---|---|
| 1 | A(3d), B(1h), C(2d) closed + running R → B, C, A; R not listed | pass | unit test "newest finished first, active tasks excluded" |
| 2 | 20 closed → exactly the 15 newest | pass | unit test "caps at the 15 newest" |
| 3 | no `updated_at` → sorted by `created_at` | pass | unit test "falls back to created_at" |
| 4 | failed task in Needs you (`exclude`) not repeated | pass | unit test "excluded (Needs you) tasks are not repeated", plus live check |
| 5 | age cell of task created 5d ago, finished 1h ago reads `1h` | pass | `live-check.txt`: the real `ago()` from dashboard.html gives `1h`. The template uses `ago(t.updated_at \|\| t.created_at)` (dashboard.html:205). Live rows show finish age, not creation age, e.g. T0043 age=3h, created 1d ago |
| 6 | `task ls --all` and `/tasks` ordering unchanged | pass | `scope-diff.txt`: only `src/dashboard.html` and the new test changed. `listTasks` is still `ORDER BY priority ASC, created_at ASC` |

Live data check (`test-round-1/live-check.ts`, read-only GET on the running daemon's `/tasks?all=1`, 57 tasks): it runs the helper extracted from the branch's dashboard.html with the dashboard's own `needs` computation. Recent comes out T0057, T0055, T0050, … ordered by finish time. That matches an independently computed expectation, and the first row is the newest finished task. Before the fix, the same data gave T0001…T0015. Reproduce with `bun specs/t0058-dashboard-recent-shows-newest/qa/test-round-1/live-check.ts src/dashboard.html` (needs `FOREMAN_URL` / `FOREMAN_TOKEN`).

Not done: the dashboard was not opened in a browser, because the running taskd serves main's copy and the task says no restart. The changed render path is the one-line helper plus the `ago()` argument, and both are exercised above.

## Failures
None.
