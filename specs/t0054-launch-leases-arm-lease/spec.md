# Launch and leases: arm lease after launch, runner check-in, herdr timeouts, sleep recovery, result recovery

_Created by Foreman T0054._ Source: triage T0053, `specs/triage/steps-die-before-the-runner-starts-under-load-le.md` (Part A only; cost accounting is Part B, a separate task).

## Goal

Make step launch and heartbeat leases hold up on a slow host and across a Mac sleep, so that:

- a step is never failed before its runner has started;
- a run that finished is never thrown away;
- attempts whose runner never started do not use up `max_attempts`.

## Background (what goes wrong today)

- `tryLaunch` (`src/taskd.ts:402`) sets `lease_until = now + lease_sec` (150 s) **before** awaiting herdr. Under load the herdr calls took 4–6 min (T0049 triage#1/#2). The lease had lapsed before the tab existed, and the next tick expired the step and closed the tab before the runner ever reached `mkdir runDir`.
- herdr calls (`src/herdr.ts:9`) have no timeout.
- `tryLaunch` runs inside the non-reentrant `tick`, so a slow launch freezes expiry and every other launch.
- `expireLeases` compares against wall-clock time. A 7-minute clamshell sleep (00:56–01:03 UTC on 2026-11-04) expired two live runners on the first tick after wake. One of them, T0037 plan#2, had already finished: its `transcript.jsonl` ends with a `result` event ($2.74, 36 turns, `status: done`). The tab was closed before `report.json` was written, so the result was lost.
- `failureCount` counts every failed row, so two launch hiccups left T0049 one failure away from failing outright.

## Scope

### S1. Lease armed after launch

- New additive columns on `steps`: `launch_started_at`, `launched_at` and `runner_seen_at` (all `TEXT`, NULL by default).
- When `tryLaunch` marks a step `running` it sets `started_at = launch_started_at = now` and `lease_until = now + launch_grace_sec`. This is the launch deadline. It no longer sets `now + lease_sec` at this point.
- When the launch returns, taskd sets `launched_at = now`, `lease_until = now + lease_sec` and the tab ids. It does this only if the step is still the live running attempt. Otherwise it closes the new tab and leaves the row alone.
- A runner check-in (S2) arms `lease_until = now + lease_sec` as well, even when it arrives before the launch returns.
- New config keys under `[defaults]`:
  - `launch_grace_sec`, default 600;
  - `launch_attempts_max`, default 3;
  - `herdr_timeout_sec`, default 120 (see S3).
- Failure texts:
  - The launch deadline passes while the launch is still in flight (`launched_at` is NULL): `runner never started: launch timed out after <N>s`. N is the number of seconds since `launch_started_at`.
  - The herdr call throws: `runner never started: <error message>`.
  - The launch returned but no check-in arrived before the lease ran out (`runner_seen_at` is NULL): `runner never started: no check-in within <lease_sec>s of launch (launch took <M>s)`.
  - A runner that checked in and then stopped heartbeating keeps the existing text, `lease expired: runner stopped heartbeating`.
- Never-started failures record the event `step.never_started` with `{ step, attempt, error }`. The existing `step.lease_expired` and `step.launch_failed` events remain for the other cases.
- **Not counted.** `failureCount` skips failed rows where `runner_seen_at IS NULL` and `error` starts with `runner never started`.
- **Separate bound.** When the latest attempt is a never-started failure and the trailing run of consecutive never-started failures for that step (counted since the last `[user-retry]`) reaches `launch_attempts_max`, the task fails with `step '<name>' could not start a runner <N> times: <last error>`. Below the bound, taskd relaunches the step as attempt+1 with the **same** `session_id` and `resume_prompt` as the attempt that never started, minus any `[user-retry]` prefix. A resume after a block answer therefore still carries the answers.

### S2. Runner check-in

- `src/runner.ts`: straight after `GET /steps/:id/context` succeeds, and before `mkdirSync(runDir)`, the runner sends one `POST /steps/:id/heartbeat`. If the reply says `cancel`, the runner prints a line and exits without spawning claude. A failed check-in is logged and the run continues; the periodic heartbeat retries it.
- The heartbeat route sets `runner_seen_at = now` on each live heartbeat, along with `lease_until`. So `runner_seen_at` holds the time the runner was last seen, and `NULL` means it never checked in.
- `task show` adds one line under each **running** step:
  - `      runner seen <ago> ago`, or
  - `      runner not seen yet (launch started <ago> ago)`.

  No other CLI output changes.

### S3. Timeouts on herdr calls

- `run()` in `src/herdr.ts` takes a timeout. The default comes from `herdr_timeout_sec` and is set once by taskd through `herdr.setTimeoutSec()`.
- When the timeout expires, `run()` kills the child and rejects with `herdr <call> timed out after <N>s`. `<call>` is the subcommand pair: `workspace list`, `workspace create`, `tab create`, `pane run`, `tab close` or `notification show`.
- If `pane run` fails after `tab create` succeeded, `launchInTab` closes the tab before it rethrows.
- `closeTab` and `notify` still swallow errors. They are now bounded by the timeout.
- When a launch fails this way, the step error reads `runner never started: herdr tab create timed out after 120s`.

### S4. Launch does not stall the tick

- `tryLaunch` keeps the synchronous part inside the tick: the concurrency and dispatch checks, and the `running` transaction with the launch deadline. It then starts the herdr (or fallback spawn) part as a promise that the tick does not await. The promise is tracked in an in-memory `launching: Map<stepId, Promise>` and removed in `finally`.
- Concurrency accounting is unchanged. A launching step already has `status = 'running'`, so `runningCount` counts it.
- When the launch finishes, taskd records the `step.started` event and log line, as it does today, and schedules a tick (`setTimeout(tick, 50)`).
- `expireLeases` no longer awaits `closeTab` one tab at a time. The close runs after the state change and is not awaited (it is bounded by S3).

### S5. Sleep and stall recovery

- `tick` records the wall time at which each tick starts. If the gap since the previous tick start exceeds `2 × heartbeat_sec`, every running lease is extended by the gap (`lease_until += gap`) **before** `expireLeases` runs. The tick then logs `tick gap <N>s (host sleep or stall): extended <k> lease(s)` and records the event `taskd.stall` with `{ gap_sec, extended }`.
- Startup R3 and stall recovery share one helper, `extendRunningLeases`. Startup keeps its current behaviour, `now + lease_sec`.

### S6. Result recovery from the transcript

- In the `expireLeases` fallback, when `report.json` is missing but the last parseable line of `<runDir>/transcript.jsonl` is a `{"type":"result"}` event, taskd:
  - builds a report: `{ exit_code: 0, killed: null, session_id, result: <event>, stderr_tail: "", run_dir, recovered_from: "transcript" }`;
  - writes it to `report.json`;
  - records `step.result_recovered` with `{ step, attempt, source: "transcript" }` (the existing report.json path gets `source: "report"`);
  - applies the report through `handleResult`.

  The step therefore completes with its real summary, cost and turns.
- Recovery is checked before any never-started or heartbeat classification.

## Acceptance scenarios

- **AS-1 (T0049 reproduction).** Setup: a stub `herdr` whose `tab create` sleeps 3 s, `lease_sec = 1`, `launch_grace_sec = 30`. Launch one step and keep ticking during and after the launch. Expected:
  - The step is still `running` after the launch returns.
  - `launched_at` and `tab_id` are set.
  - `lease_until` is about `launched_at + lease_sec`.
  - The step is not failed with "stopped heartbeating".
- **AS-2 (tick not stalled).** While the stub `tab create` is sleeping, `tick()` returns in well under the sleep (< 1 s). The same tick can expire another step's lease.
- **AS-3 (launch grace).** Setup: a stub `tab create` sleeps 3 s, `launch_grace_sec = 1`. Expected:
  - A tick after 1 s fails the step with `runner never started: launch timed out after 1s` and records `step.never_started`.
  - When the launch later returns, the stub records a `tab close` for the new tab and the step stays failed.
- **AS-4 (never-started not counted, and bounded).** Three consecutive never-started failures of `plan` with `max_attempts = 3` and `launch_attempts_max = 3`:
  - After the first and second, `settle` relaunches with the same `session_id` and `resume_prompt`.
  - After the third, the task fails with `step 'plan' could not start a runner 3 times: …`.
  - One real failure plus two never-started failures does **not** fail the task on `max_attempts`.
- **AS-5 (herdr throws).** The stub `tab create` exits 1. The step fails with `runner never started: herdr tab create … failed …`, which is not counted.
- **AS-6 (herdr timeout).** Unit test: `run()` with a 1 s timeout against a stub that sleeps 5 s rejects within about 1–2 s with `herdr tab create timed out after 1s`. Through taskd, the step error is `runner never started: herdr tab create timed out after 1s`.
- **AS-7 (check-in).** A heartbeat on a launching step sets `runner_seen_at` and `lease_until = now + lease_sec`. A later lease expiry is classified `lease expired: runner stopped heartbeating` and is counted. `task show` prints `runner seen … ago` for that running step.
- **AS-8 (no check-in after launch).** The launch returned, nothing checked in, and the lease ran out. The step fails with `runner never started: no check-in within <lease_sec>s of launch …` and is not counted.
- **AS-9 (sleep).** A running step's `lease_until` is 30 s in the past and the previous tick started 10 min ago. On the next tick:
  - the step is still running;
  - `lease_until` has been extended by about 600 s;
  - a `taskd.stall` event records `gap_sec ≈ 600`.

  With a normal gap (2 s), the same step expires.
- **AS-10 (T0037 plan#2 recovery).** A running step has an expired lease and no `report.json`. Its `transcript.jsonl` holds assistant lines ending with `{"type":"result","subtype":"success","num_turns":36,"total_cost_usd":2.738647,"structured_output":{"status":"done",…}}`. After a tick:
  - the step is `done`, with cost 2.738647, 36 turns and the transcript's summary;
  - `report.json` exists with `recovered_from: "transcript"`;
  - a `step.result_recovered` event records `source: "transcript"`.

  If the last line is not a `result` event (or is truncated), the step expires as before.
- **AS-11.** `bunx tsc --noEmit` is clean and `bun test test/` passes.

## Out of scope

- Cost accounting: deltas across `--resume`, estimates on kill, `cost_usd` nullability (Part B). `handleResult`'s cost and turns logic is not touched.
- Pipelines, gates, and CLI output other than the single new `task show` line. Dashboard changes.
- Backoff between never-started relaunches.
- Detecting a closed tab other than through lease expiry.
- Restarting taskd. The restart is left to the user.
