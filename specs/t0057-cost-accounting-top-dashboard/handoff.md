# Handoff: T0057

## Summary
T0055 (cost accounting) is merged onto T0050 (dashboard) and T0054 (launch and leases) with a single
`--no-ff` merge commit, which keeps T0055's reviewed history. The resolution followed plan.md.
Follow-up commits:
- A lease expiry classified as "runner never started" records a known zero cost (no estimate, no
  session total). A real lease expiry still estimates from the session log.
- Result recovery from transcript.jsonl goes through `handleResult`, so it records the per-attempt
  delta. Tested.
- The Decision block's Cost fact uses `fmtTaskCost` (`~$x` estimated, `$?` unknown).
- Dashboard `money(n, est, unk)` at the collapsed row and in the recent table; header shows `today $…`.
- Fixed a flaky test fixture (step-timeouts runner test). It predates the merge: a background tick
  failed its pipeline-less task, and T0054's check-in then cancelled the runner.

## Risk
- **Restart needed**: the running taskd still has the old code. `foreman service restart` loads it,
  and on that start `cost_deltas_v1` runs once on the live DB. Checked on a copy: 484 steps, the
  cost_usd sum goes from 814.05 to 662.54, and the old figures are kept in session_cost_usd. The
  second run changes nothing. Not restarted here.
- Smoke passed only with herdr hidden, because the host was heavily loaded (see qa/smoke-notes.md).
  Re-run it with real herdr when the host is idle.

## Follow-ups
- `Store` sets no `busy_timeout`. A second process writing the DB can hit SQLITE_BUSY (seen in a
  QA script; this predates the merge).
- smoke.sh's cleanup trap exits 1 when herdr is missing, and inherits `FOREMAN_TASK` from a worker env.
