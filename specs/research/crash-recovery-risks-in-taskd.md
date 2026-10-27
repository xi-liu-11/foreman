# Crash recovery risks in taskd

T0001 research. Scope: `src/taskd.ts`, `src/runner.ts`, `src/db.ts`. Line numbers are for the 2026-10-28
working tree, which has uncommitted edits on `bcc5454` (at HEAD, `taskd.ts` lines after 324 are one lower).
Defaults from `src/config.ts:78-82`: `max_attempts=3`, `heartbeat_sec=30`, `lease_sec=150`.

## Question
Where can crash recovery, lease expiry, step retry, and the blocked/answer resume flow go wrong? For each
risk: where it is, how it fails, and how to fix it.

## Summary answer
Two problems are serious. **(1)** A runner whose lease has expired is never stopped and can still write its
result. That makes it easy to end up with two agents working in the same checkout, and an old attempt can
overwrite the state of a newer one (R1, R2). **(2)** If taskd is down for longer than `lease_sec`, every
live step looks expired the moment taskd comes back. Results posted while taskd was down are lost (R3, R4),
so recovery itself starts the duplicate runs that R1 describes. Next come state changes made of several
writes with no transaction around them, which a crash can leave half done. The resume path stalls for good
in that case (R5, R6). The remaining risks waste attempts or make the logs harder to read (R7-R10).
Most fixes are small: a fencing check on the step id and attempt, a startup grace period, retrying the
result POST, and `db.transaction` around each multi-write change.

## Findings

### R1. A late result is accepted after the lease expired (High)
- **Where:** `taskd.ts:372` accepts results for steps in `failed` as well as `running`. `handleResult`
  (`taskd.ts:211-217`) then overwrites the row without condition.
- **Scenario:** Attempt 1's runner stalls (laptop sleeps, network drops) → `expireLeases` (`taskd.ts:30-37`)
  marks it `failed` → the next `advance` → `retryOrFail` starts attempt 2 in the same `cwd`. Attempt 1 then
  wakes up and posts `done`. Its row flips from failed to done, its artifacts are registered, and its tab is
  closed. If it posts `blocked`, the task becomes `blocked` with a question while attempt 2 is still running.
  Answering that question resumes attempt 1's session as a *third* row with `attempt=2` (`taskd.ts:357`),
  so three agents can now be editing one checkout.
- **Fix:** Accept a result only when `step.status === "running"` and the step is still
  `latestStep(task_id, name)`. Otherwise log a `step.late_result` event (keep the session id for audit) and
  return 409. In the long run, add a lease token: a random `lease_id` column set in `tryLaunch`, passed to
  the runner, and required on heartbeat and result.

### R2. An expired runner is never told to stop (High)
- **Where:** The heartbeat (`taskd.ts:365-369`) only extends the lease when the step is `running`, and it
  returns `cancel:false` for a step that is `failed`/expired, or one whose task was failed by `failTask`.
  `expireLeases` (`taskd.ts:34`) does not kill the runner or close its tab.
- **Scenario:** After an expiry the old runner keeps heartbeating, gets told it is fine, and keeps running
  until `step_timeout_min`, editing files next to the retry. The same thing happens when a parallel sibling
  hits `max_attempts` and `failTask` (`taskd.ts:188-193`) fails the task while the other QA children keep
  running.
- **Fix:** Return `cancel: true` whenever `step.status !== "running"` or the task is in a terminal or
  non-running state. In `expireLeases` and `failTask`, close the step's herdr tab (when `tab_id` is set) and
  mark the other running steps of the task for cancel.

### R3. Restarting taskd expires every live lease at once (High)
- **Where:** `main()` runs `tick()` → `expireLeases()` right away (`taskd.ts:389`). Heartbeat failures in
  the runner are logged and then ignored (`runner.ts:135`).
- **Scenario:** taskd crashes or is stopped for more than 150 s while runners keep working. On restart, all
  `running` steps have `lease_until < now()`, so they are marked failed and retries launch at once. The
  original runners are still alive, which leads straight into R1/R2.
- **Fix:** At startup, before the first tick, extend every running lease
  (`UPDATE steps SET lease_until = now+lease_sec WHERE status='running'`), or skip expiry until
  `startedAt + lease_sec`. Live runners heartbeat again within `heartbeat_sec`; dead ones expire one lease
  later.

### R4. A result posted while taskd is down is lost (High)
- **Where:** `runner.ts:172` makes one `client.post` call for the result. `TaskdClient.req` throws on a
  network error (`client.ts`), so the runner exits. `report.json` is written first (`runner.ts:171`), but
  taskd never reads it.
- **Scenario:** The worker finishes a 40-minute step while taskd is restarting. The POST fails, the lease
  expires, the step is marked failed, and it is retried. A finished step is redone, or for `blocked`, the
  question never reaches the user.
- **Fix:** Retry the result POST with backoff for at least `lease_sec`, and keep heartbeating while
  retrying. Add a fallback too: before `expireLeases` fails a step, check for
  `RUNS_DIR/<task>/<step>-<attempt>/report.json` and pass it to `handleResult` if it is there.

### R5. Multi-write state changes have no transaction (Medium-High)
- **Where:** `db.ts` has no `transaction` use; every `updateStep`/`updateTask`/`insertBlock` commits on its
  own. Sequences at risk include `handleResult` (`taskd.ts:211` → `223-224`), `createStep`
  (`taskd.ts:133-135`), the QA-fail branch (`taskd.ts:106-114`), and the answer flow (`taskd.ts:348` → `357`).
- **Scenario:** taskd is killed between `taskd.ts:211` (step set to `blocked`) and `223` (insert block). The
  step is blocked, the task is still `running`, and there is no block row. `advance` returns on `blocked`
  (`taskd.ts:71`) and nothing can unstick the task. In the QA branch, a crash after `updateTask(qa_cycles)`
  but before the new target row is written means a QA cycle is counted but never run.
- **Fix:** Wrap each state change in `store.db.transaction(() => { ... })()` (bun:sqlite's
  `Database#transaction`; see https://bun.sh/docs/api/sqlite#transactions). Keep the herdr calls and other
  awaits outside it: write the state first, then do the side effects.

### R6. Resume after an answer runs only inside the HTTP handler (Medium-High)
- **Where:** `taskd.ts:348-358`. The block is marked answered before the resume step is created, and
  `advance` has no rule for a step that is "blocked with no open blocks" (`taskd.ts:71`).
- **Scenario A (crash):** taskd dies after `answerBlock` (`:348`) and before `createStep` (`:357`). The task
  stays `blocked` with no open blocks, and re-answering is refused (`:346`, "already answered").
- **Scenario B (answer comes before the result):** The worker calls `task block` (`taskd.ts:334-338`, which
  does not change task status), and the user answers before the runner posts its result. The answer handler
  sees `running` and only records the answer (`:353`). Then `handleResult` finds no *open* block for the
  step and adds a placeholder block made from `so.summary` (`:223`), so the user has to answer a second,
  made-up question.
- **Fix:** Move resume into the scheduler. In `advance`, when the latest step is `blocked` and has no open
  blocks, create the resume step there. The answer endpoint then only writes the answer and calls `tick`.
  This also covers Scenario B, because `handleResult` can skip adding a placeholder block when the step
  already has answered blocks.

### R7. Block/answer cycles use up the retry budget (Medium)
- **Where:** Resume uses `step.attempt + 1` (`taskd.ts:357`), and `retryOrFail` compares `attempt` with
  `max_attempts` (`taskd.ts:125`).
- **Scenario:** A step that blocks twice is on attempt 3. Its first real failure fails the whole task with
  no retry.
- **Fix:** Count failures on their own (e.g. a `failures` column, or count earlier `failed` rows for that
  step name since the last `done`/user retry) and compare that with `max_attempts`.

### R8. User retry reuses attempt numbers and run directories (Medium)
- **Where:** `/retry` inserts `attempt: 1` (`taskd.ts:327`). The run directory is `<name>-<attempt>`
  (`runner.ts:52`, `taskd.ts:164`), and the transcript is opened with `appendFileSync` (`runner.ts:150`).
- **Scenario:** After a retry, the new transcript is appended to attempt 1's file, while `report.json`,
  `system.md` and `console.log` are overwritten. A report.json fallback for R4 could also read a stale
  report from the earlier run.
- **Fix:** Name run directories by step id (`<name>-s<id>`), or keep attempts increasing and reset only
  the failure counter from R7.

### R9. `/retry` cannot restart a failed parallel (QA) step (Medium)
- **Where:** `taskd.ts:321-324` look up `current_step` among agent steps and parallel *children*, but for a
  QA failure `current_step` is the parallel group's name.
- **Scenario:** A task fails at its QA group (child out of attempts). `/retry` returns "cannot retry at step
  'qa'", and the only option left is to create a new task.
- **Fix:** If `cur` names a parallel group, queue fresh rows for the children whose latest row is `failed`
  (or for all of them), then call `tick`.

### R10. Background runners are tied to the taskd process (Low-Medium, inferred)
- **Where:** `taskd.ts:167` uses `Bun.spawn(...).unref()`. Inferred, not tested: unref only stops taskd
  from waiting on the child. The runner stays in taskd's process group, so a Ctrl-C on taskd's terminal also
  sends SIGINT to every runner that is not running in herdr.
- **Scenario:** Restarting taskd in the foreground kills all background workers. Recovery then waits a full
  lease (150 s) and spends one attempt on each of them.
- **Fix:** Start the child in its own session (`setsid` wrapper or Bun's detached option if available), or
  have the runner ignore SIGINT and rely on cancel via heartbeat.

## Options considered
- **Fencing per step (chosen):** results and heartbeats count only from the current, `running` attempt.
  This is cheap and local, and the old row stays as the audit record.
- **Probing processes/tabs on restart:** more accurate than a grace period, but taskd stores no PIDs and
  herdr tabs may be on other machines. The grace period plus report.json covers most of it.
- **Event-sourcing state from `events`:** too large a change for now; `db.transaction` is enough.

## Recommendation
Order: R1+R2 (fencing, cancel on stale heartbeat), R3 (startup grace), R5 (transactions), R6 (resume in
the scheduler), R4 (result retry plus report.json), R7/R8 together (shared attempt model), then R9, R10.
R1-R3 are a few dozen lines in `taskd.ts`. Add a smoke test that kills taskd mid-step for > `lease_sec`.

## Open questions
- Does herdr keep panes alive across a taskd restart, and can `closeTab` reach a pane from a previous taskd
  process? This decides whether R2's "close tab on expiry" is reliable.
- When a stale attempt finishes successfully (R1), should its work ever be used (e.g. if the retry fails
  later), or always thrown away? This report assumes it is thrown away.
- Does Bun.spawn in the pinned Bun version support a detached/new-session option (R10)? Not checked.
