# T0048 test round 1: device lane

Verdict: **pass**. All 15 acceptance scenarios pass. One smoke-suite failure is
a timing flake that also happens on `main` (details and reproduction below).

Branch `fm/t0048-device-lane-resource-groups` at `424398c`. Verification mode:
inspect. The automated suite, the e2e smoke script, the CLI against a real
in-process taskd, and the dashboard in headless Chrome. Evidence is in
`qa/test-round-1/`.

## Counts

Foreman has one platform (a local Bun daemon and CLI). It has no device or
browser matrix.

| suite | run | passed | failed | skipped |
|---|---|---|---|---|
| `bunx tsc --noEmit` | 1 | 1 | 0 | 0 |
| `bun test` (10 files, including the new `test/lane-taskd.test.ts`) | 140 | 140 | 0 | 0 |
| `test/smoke.sh` flows (clean env, final branch run 5) | 10 | 10 | 0 | 0 |
| `test/smoke.sh` across branch runs 4–7 | 4 runs | 1 | 3 (outage flow only, flake, see below) | n/a |
| dashboard Devices card (headless Chrome) | 1 | 1 | 0 | 0 |

## Acceptance scenarios

| AS | result | evidence |
|---|---|---|
| AS-1 group capacity 1 | pass | `test/leases.test.ts` "AS-1 …". `test/lane-taskd.test.ts`: through the real CLI, B's `task lease android-emu --wait 1` exits 3 while A holds ios-sim, then B is granted after `task release` |
| AS-2 one slot per step | pass | `test/leases.test.ts` "AS-2 …" |
| AS-3 capacity 2 | pass | `test/leases.test.ts` "AS-3 …" |
| AS-4 per-resource exclusivity | pass | `test/leases.test.ts` "AS-4 …" |
| AS-5 grant ranking | pass | `test/lane.test.ts` orderWaiters AS-5. `test/leases.test.ts` "AS-5 grant order through the store". `/lanes` fixture: test qa0 is ranked before an older implement (`lanes-endpoint.json`) |
| AS-6 FIFO within a task | pass | `test/lane.test.ts` "AS-6 …" |
| AS-7 ungrouped resources | pass | The existing `test/leases.test.ts` cases are unchanged (the diff against main only adds lines) and pass |
| AS-8 device_steps_running | pass | `lane.test.ts` (pure). **New** `lane-taskd.test.ts` through `tick()`→`tryLaunch`: the third implement stays queued with `step.deferred{reason: device_limit}`, the queued `plan` is launched, and `task ls` shows `queued: device lane` |
| AS-9 dispatch preference | pass | `lane.test.ts` (pure). **New** test through `tick()`: a newer `test` is launched and the older `implement` is deferred `ranked_behind` |
| AS-10 no lane configured | pass | `lane.test.ts` (pure). **New** test through `tick()`: with no groups, a third device-named step is launched and gets no deferred event |
| AS-11 expect | pass | `leases.test.ts` AS-11 ×2. **New** test with the real CLI: `--expect 25` stores `expect_min=25`; `task leases` prints `expect ~25m (24m left)` and the waiter's `eta ~24m`; `task show` prints expect and eta; after a grant backdated by 30 min, one `lease.overdue` fires (lease_max 45) |
| AS-12 CLI compatibility | pass | `lane-cli.test.ts` and the new test: `--expect 0/-3/abc` exits 1 with no request (no lease row is created); the server returns 400 for `expect_min: 0`; exit 0 when granted; `--wait` exits 3 when still queued; `--json` is still the lease array |
| AS-13 migration | pass | `leases.test.ts` "AS-13 an old-schema database opens …" |
| AS-14 visibility | pass | New test: `waiting for devices (1st)`, `queued: device lane`. Dashboard: `dashboard-device-lane.png`, `dashboard-dom.html` (group, cap, holder with expect, waiters in grant order with ETAs) |
| AS-15 config parsing | pass | `lane.test.ts` "AS-15 …" and "explicit device_steps …". `unknownDeviceSteps` is logged at startup (code read, `src/taskd.ts` main) |

Scope item 8 (read-only check, `config-and-docs.txt`): the live tackle-tally
config has `concurrency = 3`, the `devices` group with capacity 1 and
`device_steps = ["implement", "test"]`. The backup `~/.foreman/config.toml.bak-t0048`
exists. README and SKILL.md document groups, `device_steps`,
`device_steps_running` and `--expect`.

## Tests added

`test/lane-taskd.test.ts` (4 tests). It covers AS-8, AS-9 and AS-10 through the
real `tick()`/`tryLaunch`, and AS-1, AS-11, AS-12 and AS-14 through the real
CLI against `route()`. The project path does not exist, so a step that passes
dispatch fails with `cwd missing` and no worker is spawned. The test strips the
worker's own `FOREMAN_TASK`/`FOREMAN_STEP` from the CLI env.

## Smoke failure: "taskd outage longer than the lease mid-step" (flake, also on main)

Symptom: `expected 1 attempt, got 2` (smoke-run4, run6, run7).

Cause: the flow kills taskd 3 s after it launches the step. On this host (load
average 14–21) the herdr tab's runner takes 2–6 s to reach
`GET /steps/:id/context` (`src/runner.ts:22`, which this branch does not
change). When taskd is already down, the runner dies before it creates its run
dir: `runs/T0005/research-1` is missing in every failed run. Its lease then
expires and attempt 2 runs. `main` shows the same lost-heartbeat expiries in
its smoke runs (T0008 handoff#1, T0009 review#2/test#2).

Separating flake from regression (`outage-only.sh`, `outage-only-results.txt`):
the outage flow alone, interleaved, with the same config:

| | runs | 1 attempt (pass) | >1 attempt |
|---|---|---|---|
| branch | 4 | 1 | 3 |
| main (`git archive main`) | 4 | 0 | 4 |

The full smoke on main passed 2 of 2 with a clean env (`smoke-main-cleanenv-*.txt`),
and the branch passed 1 of 4 (`smoke-run5-cleanenv.txt`). The isolated
repro shows main failing just as often, so this is not a regression.

Reproduce (from a checkout):
```
env -u FOREMAN_TASK -u FOREMAN_STEP -u FOREMAN_STEP_NAME -u FOREMAN_RUN_DIR -u FOREMAN_CLI_NAME \
  sh specs/t0048-device-lane-resource-groups/qa/test-round-1/outage-only.sh "$PWD" lane
# attempts=2 … runner_wrote=none  → flake hit; attempts=1 → passed
```

## Other observations (not failures)

- **smoke.sh inherits the worker's env.** Run inside a Foreman step,
  `FOREMAN_TASK`/`FOREMAN_STEP` leak into its `task` calls. On main this broke
  `task ticket show TST-1 --project direct` ("project (or task) required",
  `smoke-main-baseline.txt`). Runs 1–3 also collided with smoke runs started
  from this same worktree by another process, which shared port 7778 and the
  `fm:smoke` herdr workspace. Only the clean-env runs (5–7, main-cleanenv) are
  used for the verdict.
- Dashboard: under the lane block, the per-resource table still shows
  `android-emu free` while a waiter is queued for it, because the lane is what
  holds it back. This is correct per key, but readers may find it confusing.
  The lane lines above the table explain it.
- `bun test` logs `advance … failed: … 'ps.type'` noise from tests that insert
  tasks with fake pipelines. That code path (`src/taskd.ts:153–160`) is not
  changed by this branch, and it is not a failure.
- taskd loads config only at startup (`src/taskd.ts:23`). The live config
  already says `concurrency = 3` for tackle-tally. If taskd restarts **before**
  this branch is merged, tackle-tally runs 3 workers with no lane. Restart
  only after the merge.

## Evidence files

`test-round-1/`: `tsc.txt`, `bun-test.txt`, `lane-taskd-test.txt`,
`smoke-run1..7*.txt`, `smoke-main-baseline.txt`, `smoke-main-cleanenv-{1,2}.txt`,
`outage-only.sh`, `outage-only-results.txt`, `dashboard-fixture.ts`,
`lanes-endpoint.json`, `dashboard-device-lane.png`, `dashboard-dom.html`,
`config-and-docs.txt`.
