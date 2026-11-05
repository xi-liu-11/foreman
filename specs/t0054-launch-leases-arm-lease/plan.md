# Plan: Launch and leases (T0054)

See `spec.md` for scope and the acceptance scenarios (AS-n). Verification mode is inspect: `bunx tsc --noEmit` and `bun test test/`. There is no device suite. Do **not** restart the live taskd.

## Approach

All of the logic stays in `src/taskd.ts`. It sits next to the code it changes, so no new module is needed. `herdr.ts` gains a timeout and `runner.ts` gains one call. The DB gains three nullable columns.

### Step lifecycle after the change

```
queued ──tryLaunch (in tick, sync)──▶ running  started_at=launch_started_at=now, lease_until=now+launch_grace_sec
                                        │  launching.set(id, launch())   ← not awaited by tick
   runner heartbeat (any time) ───────▶ runner_seen_at=now, lease_until=now+lease_sec
   launch() resolves, still live ─────▶ launched_at=now, tab ids, lease_until=now+lease_sec, step.started
   launch() resolves, not live  ──────▶ closeTab(new tab); row untouched
   launch() throws, still live ───────▶ failed "runner never started: <msg>", step.never_started
expireLeases (lease_until < now):
   report.json present        → handleResult (existing R4)
   transcript ends in result  → write report.json, handleResult        (S6)
   runner_seen_at NULL, launched_at NULL, launch_started_at set → "runner never started: launch timed out after Ns"
   runner_seen_at NULL, launched_at set → "runner never started: no check-in within <lease_sec>s of launch (launch took Ms)"
   otherwise                  → "lease expired: runner stopped heartbeating" (unchanged)
```

- **Legacy rows.** A step launched by the old taskd has `launch_started_at` NULL. It is treated as launched, so a dead runner gets the old "stopped heartbeating" text.
- **Never-started detection.** `isNeverStarted(s) = s.status==='failed' && !s.runner_seen_at && s.error?.startsWith('runner never started')`.
- **Rows still running across a restart.** The old taskd launched them, so `runner_seen_at` is NULL until the next heartbeat, at most 30 s away. Startup extends their leases by `lease_sec` first, so nothing is misclassified. This is why a restart is safe while steps run.

### Stall detection

- A module variable `lastTickStart: number | null` holds when the previous tick started.
- At the top of `tick`, after the `ticking` guard, compute `gap = Date.now() - lastTickStart`. When `gap > 2 * heartbeat_sec * 1000`, call `extendRunningLeases(s => s.lease_until + gap)`.
- Then set `lastTickStart = Date.now()`.
- An interval tick that returns early because a tick is already running does not update `lastTickStart`. A tick stalled on an await therefore also counts as a gap, which is the desired behaviour.

### Test hooks

taskd exports one object, matching the existing `export`-for-tests style (`route`, `tick`, `cfg`):

```ts
export const testHooks = {
  setHerdrOk(v: boolean) { herdrOk = v },
  setLastTickStart(ms: number | null) { lastTickStart = ms },
  launchesSettled: () => Promise.allSettled([...launching.values()]),
};
```

### Stub herdr for tests

Each test file writes a small `sh` script named `herdr` into a temp `bin` dir on PATH, following the pattern of `test/early-end.test.ts`.

- The script appends `"$@"` to `$HERDR_LOG`.
- For `workspace list` it prints `{"result":{"workspaces":[{"label":"fm:<P>","workspace_id":"w1"}]}}`.
- For `tab create` it runs `sleep ${HERDR_TAB_SLEEP:-0}`, or exits with `${HERDR_TAB_EXIT}` if that is set. It then prints `{"result":{"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"p1"}}}`.
- `pane run`, `tab close` and `notification show` exit 0.
- Use `exec sleep` so that a timeout kill terminates the sleeper.

The stub must not run the real runner. `pane run` does nothing, so no claude is spawned and no `FOREMAN_CLAUDE_BIN` is needed.

## Files to touch, in order

1. **`src/db.ts`**
   - Add `launch_started_at`, `launched_at` and `runner_seen_at` (`string | null`) to `StepRow`.
   - Add an additive migration (`ALTER TABLE steps ADD COLUMN … TEXT`) next to the `timeout_min` migration at `db.ts:197`.
   - Add the three columns to the `CREATE TABLE` for fresh DBs.
2. **`src/config.ts`**
   - Add `launch_grace_sec` (600), `launch_attempts_max` (3) and `herdr_timeout_sec` (120) to `Defaults`, `DEFAULTS`, and the commented template near `heartbeat_sec`/`lease_sec` (`config.ts:135`).
3. **`src/herdr.ts`**
   - `let timeoutSec = 120; export function setTimeoutSec(n)`.
   - Rework `run(args, timeoutMs = timeoutSec*1000)` to race `proc.exited` against a timer. On timeout: `proc.kill()`, then throw `herdr <args[i], args[i+1]> timed out after Ns`. The call name is the two words after `herdr` and an optional `--machine X`.
   - In `launchInTab`, wrap `pane run` in try/catch: on failure, `closeTab(tab_id)` and rethrow.
   - Export `run` as `runHerdr` for the unit test only if needed. Alternatively test through `launchInTab` with the stub.
4. **`src/runner.ts`**
   - After `client.get('/context')`, call `client.post('/steps/:id/heartbeat', {})` inside a try/catch. On `cancel`, log and `return`.
   - Then `mkdirSync(runDir)`. No other changes.
5. **`src/taskd.ts`**, in this order:
   1. Call `herdr.setTimeoutSec(cfg.defaults.herdr_timeout_sec)` at module init.
   2. Heartbeat route (`:877`): also set `runner_seen_at: now()` when the step is live.
   3. `extendRunningLeases(newUntil, why)` helper. Use it in `main` (R3) and in `tick` (stall), with the `taskd.stall` event and log line.
   4. `tryLaunch`: keep the checks and the running transaction, now with `launch_started_at` and the grace deadline. Move the env and command setup plus the herdr or fallback calls into `async function launch(task, step, proj, cwd)`. Then:
      - `launching.set(step.id, launch(...).finally(() => launching.delete(step.id)))`.
      - In `launch`, after the await, re-read the step. If `!isLive(fresh)`, close the new tab (fire-and-forget) and return.
      - Otherwise update `launched_at`, the tab ids and `lease_until`, then emit `step.started`, log, and call `setTimeout(tick, 50)`.
      - On a throw, if the step is still live, fail it with `runner never started: ${e.message}`, emit `step.never_started` (with `step.launch_failed` kept as well), release step leases, and call `setTimeout(tick, 50)`.
      - The fallback `Bun.spawn` path goes through the same `launch()`.
   5. `expireLeases`:
      - Add a transcript recovery helper, `recoverFromTranscript(runDir)`. It returns the report body or null. It reads `transcript.jsonl`, walks back to the last non-empty line that parses as JSON, and requires `type === 'result'`.
      - Add the never-started classification above. Emit `step.never_started` for those and `step.lease_expired` for the rest.
      - Do not await `closeTab`.
      - Mark the step in `cancelRequested` as today.
      - A launch that is still in flight for an expired step finds the step not live when it resolves, and closes its tab.
   6. `failureCount`: skip never-started rows. Add `neverStartedStreak(task_id, name)`, which counts trailing never-started failed rows and resets at a `[user-retry]` row.
   7. `settle`, `case "failed"`: if `isNeverStarted(latest)`, then:
      - when the streak is at or above `launch_attempts_max`, call `failTask(task, "step '<n>' could not start a runner <N> times: <err>")`;
      - otherwise call `createStep(task, name, role, attempt+1, latest.session_id, latest.resume_prompt?.replace(/^\[user-retry\]\s*/, "") ?? null)`.

      Otherwise the existing path runs.
   8. Export `testHooks`.
6. **`src/cli.ts`** (`task show`, `:155`): for `s.status === "running"`, append a line, either `\n      runner seen ${ago(s.runner_seen_at)} ago` or `\n      runner not seen yet (launch started ${ago(s.launch_started_at ?? s.started_at)} ago)`.
7. **Tests** (new files; each uses its own temp `FOREMAN_HOME` and the PATH stub):
   - `test/launch.test.ts`: AS-1, 2, 3, 4, 5, 7, 8.
   - `test/herdr-timeout.test.ts`: AS-6.
   - `test/stall.test.ts`: AS-9.
   - `test/result-recovery.test.ts`: AS-10.
8. **`README.md`**: add a `### Launch and leases` section after `### Step timeouts`. It should cover:
   - the lifecycle in prose;
   - the three new keys;
   - the error texts;
   - that never-started attempts do not count against `max_attempts` and have their own bound;
   - tick-gap extension and transcript recovery;
   - the `task show` line;
   - "a running taskd must be restarted to pick this up; the restart is safe while steps run".

## Verification per slice

| Slice | Check |
|---|---|
| db + config | `bunx tsc --noEmit`. Open a fresh Store in a temp home and check that `PRAGMA table_info(steps)` lists the 3 columns. The existing tests still pass, which shows the migration works on an existing schema. |
| herdr timeout | `bun test test/herdr-timeout.test.ts` (AS-6). |
| runner check-in | Inspect: no test harness covers runner.ts end to end. AS-7 covers the taskd side through the route. Check by reading that the check-in comes before `mkdirSync`. |
| taskd launch/lease | `bun test test/launch.test.ts`. |
| stall | `bun test test/stall.test.ts`. |
| recovery | `bun test test/result-recovery.test.ts`. |
| cli | Covered by AS-7 if the test drives `task show`. Otherwise call the formatter through the CLI against a temp taskd, as `test/reject-cli.test.ts` does. A visual check of one line is acceptable. |
| all | `bunx tsc --noEmit && bun test test/` green; `test/smoke.sh` if it already runs in CI-like local use. |

## Risks

- **Async launch (S4)** adds in-memory state.
  - A taskd restart mid-launch leaves a running row with `launched_at` NULL. Startup extends its lease by `lease_sec`. If no runner ever heartbeats, the row expires as `runner never started: launch timed out …` and is not counted. That is correct.
  - If the pane did start, the runner's heartbeat sets `runner_seen_at` and the step proceeds normally.
- **Orphan tabs.** A herdr call that times out may still finish later and leave a tab with no step. This is accepted: the tab's runner would get `cancel` on its first heartbeat (not live) and exit. `pane run` failure closes the tab it just created.
- **Unbounded relaunch** without the streak bound. This is mitigated by `launch_attempts_max`, which AS-4 tests. Reset only on `[user-retry]`. Strip that prefix when carrying `resume_prompt` forward, or the streak would reset on every relaunch.
- **Stall extension** also fires for a taskd that is genuinely blocked. It extends leases at most once per gap, which is the same trade-off as R3.
- **Transcript recovery** must only apply this attempt's result. The run dir is per attempt (`<step>-<attempt>`), so it does. A truncated last line is ignored and the step expires as before.
- **Heartbeat write.** `runner_seen_at` adds a column write to every heartbeat. It is the same UPDATE statement, so the cost is negligible.
- **Tests and the live DB.** Every new test must keep the `DB_PATH` under-tmpdir guard used by existing tests.
