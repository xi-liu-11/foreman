# T0048 test round 2: device lane

Verdict: **pass**. All 15 acceptance scenarios still pass after the review
round 1 fixes (R1, R2, commit `ab00eed`). Every flow of the smoke suite passed
on the first run, including the outage flow that flaked in round 1. I added a
test that runs R2 through the real `/lanes` route and the real CLI.

Branch `fm/t0048-device-lane-resource-groups` at `ab00eed`, plus the test added
in this round. Verification mode: inspect. Evidence is in `qa/test-round-2/`.

## Counts

Foreman has one platform: a local Bun daemon and CLI. There is no device or
browser matrix.

| suite | run | passed | failed | skipped |
|---|---|---|---|---|
| `bunx tsc --noEmit` | 1 | 1 | 0 | 0 |
| `bun test`, 10 files (final run, includes the new R2 test) | 143 | 143 | 0 | 0 |
| lane suites (`lane`, `lane-cli`, `lane-taskd`, `leases`) | 55 | 55 | 0 | 0 |
| `test/smoke.sh` flows (1 run, clean env, load average about 18–24) | 11 | 11 | 0 | 0 |
| dashboard Devices card (headless Chrome, fixture) | 1 | 1 | 0 | 0 |

## Review round 1 fixes

| item | result | evidence |
|---|---|---|
| R1a: a cancelled or failed task with a stale held-back entry shows its real status | pass | `lane-taskd.test.ts` "R1 …": a held `implement` gets `deferred/device_limit`. After the task is set to `cancelled`, `/tasks` returns `lane: null`, and `task ls --all` prints `cancelled` |
| R1b: a concurrency hold clears the lane reason | pass | Same test: at concurrency 2 the step stays `queued` and `lane` is `null`. `tick()` also drops `deferred` entries for steps that are no longer queued (`src/taskd.ts:135`) |
| R2: `task leases` scopes lanes the same way as the table | pass | `lane-cli.test.ts` (stub server): the queries are `?task=`, `?project=`, and empty. **New** `lane-taskd.test.ts` "R2 via route and CLI": there are two lane projects, each with a held lease. `/lanes?task=<P2 task>` returns only P2. `?project=P1` returns only P1, and an unscoped call returns both. Real `task leases` with no env prints both lane headers. With `FOREMAN_TASK` set, it prints only that task's project. The fixture `lanes-by-task.json` also resolves `?task=` to tackle-tally |

## Acceptance scenarios

| AS | result | evidence |
|---|---|---|
| AS-1 to AS-4 group capacity, one slot per step, capacity 2, key exclusivity | pass | `leases.test.ts` AS-1..4, plus `lane-taskd.test.ts` AS-1 through the CLI (the waiter exits 3, then is granted after release) |
| AS-5 grant ranking | pass | `lane.test.ts` and `leases.test.ts` AS-5. The dashboard and `/lanes` put `test` qa0 ahead of an older `implement` |
| AS-6 FIFO within a task | pass | `lane.test.ts` AS-6 |
| AS-7 ungrouped resources | pass | The original `leases.test.ts` cases are unchanged and pass |
| AS-8 device_steps_running | pass | `lane-taskd.test.ts` AS-8 via `tick()` |
| AS-9 dispatch preference | pass | `lane-taskd.test.ts` AS-9 via `tick()` |
| AS-10 no lane configured | pass | `lane-taskd.test.ts` AS-10 via `tick()` |
| AS-11 expect | pass | `leases.test.ts` AS-11 and `lane-taskd.test.ts`: the CLI `--expect 25` is shown with an ETA, and the overdue check uses it |
| AS-12 CLI compatibility | pass | `lane-cli.test.ts` and `lane-taskd.test.ts`: a bad `--expect` exits 1 with no request; exits 0 and 3 behave as before; `--json` returns the array |
| AS-13 migration | pass | `leases.test.ts` AS-13 |
| AS-14 visibility | pass | `task ls` shows `waiting for devices (1st)` and `queued: device lane`. The dashboard shows the group, the holder with expect, and the waiters in grant order with ETAs (`dashboard-device-lane.png`, `dashboard-dom.html`) |
| AS-15 config parsing | pass | `lane.test.ts` AS-15 |
| smoke "device lane / task leases shows the lane" | pass | `smoke-run1.txt` |

I checked scope item 8 read-only (`config-and-docs.txt`). The live tackle-tally
config has `concurrency = 3`, the `devices` group with capacity 1, and
`device_steps = ["implement", "test"]`. The backup
`~/.foreman/config.toml.bak-t0048` exists. README and SKILL.md document the
feature. **Do not restart taskd now:** tackle-tally T0037 is `running`. Restart
only after the merge, once no tackle-tally step is running.

## Test added

`test/lane-taskd.test.ts`: "R2 via route and CLI: /lanes?task= scopes to the
task's project; unscoped task leases prints every project's lane".

## Observation: a test that depends on the environment (not a regression)

On the first `bun test` run, `step-timeouts.test.ts` "runner kills at
step.timeout_min" failed 6 of 6 times (`step-timeouts-reruns.txt`). The cause
was my own command, which unset `FOREMAN_CLI_NAME`. The test spawns `src/cli.ts
run-step` and inherits `process.env`. Without `FOREMAN_CLI_NAME=foreman`,
`src/cli.ts:12` falls back to `basename(argv[1])`, which is `cli.ts`, so the
CLI runs in `task` mode and rejects `run-step` ("unknown command 'run-step'").
When `FOREMAN_CLI_NAME` is kept, as taskd sets it, the test passes 2 of 2
times, and the full suite passes. This branch changes neither the test nor
`src/runner.ts`, and line 12 dates from 2026-10-28. So a plain `bun test` in a
shell with no `FOREMAN_CLI_NAME` would fail this T0045 test on main too. The fix
belongs in a follow-up: the test should set `FOREMAN_CLI_NAME: "foreman"`.

Reproduce:
```
env -u FOREMAN_CLI_NAME bun test test/step-timeouts.test.ts   # 1 fail: unknown command 'run-step'
FOREMAN_CLI_NAME=foreman bun test test/step-timeouts.test.ts  # 11 pass
```

## Evidence files

`test-round-2/`: `tsc.txt`, `bun-test.txt`, `lane-tests.txt`,
`step-timeouts-reruns.txt`, `smoke-run1.txt`, `config-and-docs.txt`,
`dashboard-device-lane.png`, `dashboard-dom.html`, `lanes-by-task.json`.
