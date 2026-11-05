# Tasks: Launch and leases (T0054)

There is no device or e2e suite in this project. Verify each task with `bunx tsc --noEmit` and the named `bun test` file. Do not restart the live taskd.

## Foundation (disjoint files, can run in parallel)

- [x] T1 [P] `src/db.ts`: add the `launch_started_at`, `launched_at` and `runner_seen_at` TEXT columns to the CREATE TABLE, add additive `ALTER TABLE` migrations next to `timeout_min`, and add the fields to `StepRow`.
- [x] T2 [P] `src/config.ts`: add `launch_grace_sec = 600`, `launch_attempts_max = 3` and `herdr_timeout_sec = 120` to `Defaults`, `DEFAULTS` and the config template comment.
- [x] T3 [P] `src/herdr.ts`:
  - add `setTimeoutSec()`;
  - give `run()` a timeout that kills the child and throws `herdr <call> timed out after Ns`;
  - make `launchInTab` close the tab if `pane run` fails.
- [x] T4 [P] `src/runner.ts`: send one heartbeat right after `GET /context` and before `mkdirSync(runDir)`. On `cancel`, exit without spawning claude. A check-in error is logged and not fatal.

## taskd (sequential, all in `src/taskd.ts`)

- [x] T5 Call `herdr.setTimeoutSec(cfg.defaults.herdr_timeout_sec)` at init. Make the heartbeat route also set `runner_seen_at`. Add `isNeverStarted()` and export `testHooks` (`setHerdrOk`, `setLastTickStart`, `launchesSettled`).
- [x] T6 Extract `extendRunningLeases()`. Use it from startup R3. In `tick`, track `lastTickStart`; when the gap exceeds `2 × heartbeat_sec`, extend leases by the gap before `expireLeases`, log the gap, and record a `taskd.stall` event (S5).
- [x] T7 Split `tryLaunch` (S1 and S4):
  - inside the tick, the running transaction sets `launch_started_at`/`started_at` and `lease_until = now + launch_grace_sec`;
  - the herdr or fallback part runs in an un-awaited `launch()`, tracked in `launching`;
  - on success while live: set `launched_at`, the tab ids and `lease_until = now + lease_sec`, emit `step.started`, and schedule a tick;
  - on success while not live: close the tab;
  - on a throw while live: fail with `runner never started: <msg>` and emit `step.never_started` and `step.launch_failed`.
- [x] T8 `expireLeases` (S1 and S6):
  - add transcript `result` recovery: write `report.json`, record `step.result_recovered` with `source`, then call `handleResult`;
  - add the never-started classification (launch timed out, or no check-in after launch) with `step.never_started`;
  - do not await `closeTab`.
- [x] T9 `failureCount` skips never-started rows. Add `neverStartedStreak()`. In `settle`'s failed case, a never-started latest attempt either fails the task once the streak reaches `launch_attempts_max` (`could not start a runner N times: …`), or relaunches with the same `session_id` and `resume_prompt`, stripping the `[user-retry]` prefix.

## CLI and docs (disjoint files, can run in parallel once T1 is done)

- [x] T10 [P] `src/cli.ts` `task show`: for running steps, print `runner seen <ago> ago` or `runner not seen yet (launch started <ago> ago)` on its own indented line.
- [x] T11 [P] `README.md`: add a `### Launch and leases` section after Step timeouts. Cover the keys, error texts, the not-counted rule and its bound, stall extension, transcript recovery, the `task show` line, and the note that a restart is needed and is safe while steps run.

## Tests (new files, can run in parallel once T1–T9 are done)

- [x] T12 [P] `test/launch.test.ts`: uses the stub `herdr` on PATH (log, `HERDR_TAB_SLEEP`, `HERDR_TAB_EXIT`) and `testHooks.setHerdrOk(true)`. Covers:
  - AS-1: slow `tab create`, then still running with the lease armed after launch;
  - AS-2: `tick()` returns fast mid-launch;
  - AS-3: grace timeout, then a late tab is closed;
  - AS-4: never-started not counted; bound at 3; one real failure plus two never-started does not fail the task;
  - AS-5: `tab create` exits 1;
  - AS-7: the heartbeat sets `runner_seen_at`, and a later expiry counts;
  - AS-8: no check-in after launch.
- [x] T13 [P] `test/herdr-timeout.test.ts`: AS-6. `launchInTab`/`ensureWorkspace` against a sleeping stub with `setTimeoutSec(1)` rejects with `herdr tab create timed out after 1s` within 3 s.
- [x] T14 [P] `test/stall.test.ts`: AS-9. Set an expired lease and `setLastTickStart(now - 600 s)`; after `tick`, the step is still running, the lease is extended by about 600 s, and a `taskd.stall` event is recorded. A control case with a normal gap expires.
- [x] T15 [P] `test/result-recovery.test.ts`: AS-10. Use a T0037 plan#2 fixture transcript ending in a `result` event (36 turns, $2.738647, status `done`). Expect the step `done` with the real summary, cost and turns, `report.json` written with `recovered_from: "transcript"`, and a `source: "transcript"` event. Also: a truncated or non-result last line expires as before.

## Close-out

- [x] T16 Run `bunx tsc --noEmit && bun test test/` and make it green. Write a handoff note stating that taskd needs `foreman service restart` to pick this up, and that the restart is safe while steps run: the migration is additive, startup extends leases, and old runners heartbeat within 30 s.
