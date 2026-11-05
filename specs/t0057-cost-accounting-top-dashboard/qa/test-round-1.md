# T0057 test, round 1

**Verdict: pass.** Every acceptance scenario AS-1 to AS-9 was checked on branch tip 1919a02 (plus
the test assertions added in this step). The only red runs are `test/smoke.sh` with real herdr on
a heavily loaded host. That is a timing flake, also seen on origin/main (see "Smoke" below). With
herdr hidden, the same smoke passes every scenario.

Host: macOS, load average 12–146 during the step. Evidence is in `test-round-1/`.

## Counts

| Suite | Run | Passed | Failed | Skipped |
|---|---|---|---|---|
| `bunx tsc --noEmit` | 1 | 1 | 0 | 0 |
| `bun test` (19 files) | 207 | 207 | 0 | 0 |
| `bun test`, 6 targeted files after the added assertions | 53 | 53 | 0 | 0 |
| `test/smoke.sh`, herdr hidden (branch) | 1 run, all scenarios | 1 | 0 | 0 |
| `test/smoke.sh`, real herdr (branch) | 2 runs | 0 | 2 (flake, see below) | 0 |
| `test/smoke.sh`, real herdr (origin/main 7bfc394, control) | 1 run | 1 | 0 | 0 |
| Isolated-taskd e2e (`qa/scripts/e2e.sh`) | 1 | 1 | 0 | 0 |
| Dashboard in headless Chrome (`test-round-1/scripts/dashboard-browser.sh`) | 2 modes (endpoint ok, endpoint 500) | 2 | 0 | 0 |
| Migration on a live-DB copy | 2 opens | 2 | 0 | 0 |

Foreman has a single target (local macOS), so there is no cross-platform matrix.

## Scenarios

| AS | Result | Evidence |
|---|---|---|
| AS-1 merge | pass | One merge commit 34107fb "Merge T0055 cost accounting onto T0050 dashboard and T0054 launch/leases" with T0055's commits behind it. `git grep -n '^<<<<<<<\|^>>>>>>>'` returns nothing (exit 1). |
| AS-2 transcript recovery is a delta | pass | `test/cost-accounting.test.ts` "T0057 AS-2" asserts `[cost_usd, session_cost_usd, turns, est, unk] = [2, 5, 4, 0, 0]`. **This step added** the missing assertion that exactly one `step.result_recovered` event with `source: "transcript"` is recorded (the review round 1 note). Green in `bun-test.txt` / `targeted-tests.txt`. |
| AS-3 never started costs nothing | pass | Test "T0057 AS-3" (a session log is on disk) now also asserts `status = failed` and one `step.never_started` event (**added in this step**), alongside `[0, 0, 0, 0, null]`. Live evidence: the smoke DB from `smoke-herdr-run2.txt`, step 7 (T0005#1 "runner never started"), has `cost_usd 0, est 0, unk 0, session_cost_usd NULL`. |
| AS-4 plain lease expiry estimates | pass | T0055's AS-7 test, `launch.test.ts`, `result-recovery.test.ts`, `stall.test.ts` and `step-timeouts.test.ts` all green, unmodified (`targeted-tests.txt`). |
| AS-5 dashboard | pass | Headless Chrome against an isolated taskd: `dashboard-ok.png` / `.dom.html`. Collapsed rows show D1 `~$1.20` (estimated), D2 `$?` (unknown only), D3 `$1.20` (known). The header ends with `· today ~$3.90 (2 est.)`. In `dashboard-fail.png` / `.dom.html` a proxy answers `/costs/today` with 500: the header renders `… · refreshed 14:01:21` with no `today` suffix, and the cards are unaffected. Unit test `costs.test.ts` "dashboard money()" is green. |
| AS-6 Decision frame | pass | Decision frame in the browser: D4 gate `Cost: ~$1.50`, D1 `~$1.20`, D2 `$?`, D3 `$1.20`. The Activity frames show no cost. `decision.test.ts` (existing `$1.75` cases plus the new `~$1.50`/`$?` case) is green. |
| AS-7 CLI | pass | `dashboard-browser.txt`: `task show D1` prints the decision block (`Cost: ~$1.20`) and the step line `~$1.20 ~3t`. `task show D5` prints `runner seen 1m ago`, and `task show D6` prints `runner not seen yet (launch started 2m ago)`. `task ls --all` footer: `today: ~$3.90 (2 estimated, 1 unknown) · qa-dash …`. `e2e-isolated-taskd.txt` covers per-attempt deltas (11.32 = 19.16 − 7.84), the kill estimate 0.054, the unknown `$?`, the `--project` footer, and `/costs/today`. |
| AS-8 migration on live data | pass | `migration-copy.txt`: a fresh `sqlite3 -readonly … .backup` copy (490 steps). Before: T0054 columns only, no meta key, 0 `costs.migrated`. After open 1: 6 columns, meta key set, 1 `costs.migrated` event, SUM(cost_usd) 826.48 → 674.97, and the old figures kept in `session_cost_usd`. After open 2: the same event count, sums, meta timestamp, and a byte-identical per-row dump. The live DB afterwards still lacks the T0055 columns (checked read-only), so it was not modified. |
| AS-9 suite | pass, with the smoke caveat | tsc clean; `bun test` 207/0. Smoke: passes with herdr hidden. With real herdr it flakes because of host load (below). |

## Smoke with real herdr (flake, not a regression)

`smoke-herdr.txt` (crash/retry: T0003 failed after 5 never-started launches) and
`smoke-herdr-run2.txt` (outage: T0005 needed 2 attempts, expected 1) both fail the same way. A
herdr tab does not check in within smoke's `lease_sec = 5`. Each such launch is classified
`runner never started: no check-in within 5s of launch` (T0054 behaviour), and the scenario
assertions then miss. Interactive shell startup measured during the step: `zsh -i -c exit` took
7.20 s, 6.13 s and 3.71 s, which is above or close to the 5 s lease. The load average was 12–95.

Control: the same command on an export of origin/main (`smoke-main-herdr.txt`) passed, but its
taskd log also has 3 `never started` launches. They just did not land in a scenario that counts
attempts. Main shows the same timing behaviour, and this merge does not touch launch or check-in
code. `smoke-no-herdr.txt` (tab launch replaced by background processes) passes every scenario,
including the T0055 `task ls` footer `today: ~$0.47 (1 unknown) · …`. Its exit 1 comes after
"smoke test passed" and is caused by the cleanup trap when `herdr` is a stub. This was already
documented in `qa/smoke-notes.md`.

Reproduce (on an idle host it should pass; under load it flakes on main too):

    env -u FOREMAN_TASK -u FOREMAN_STEP -u FOREMAN_STEP_NAME -u FOREMAN_RUN_DIR -u FOREMAN_URL \
        -u FOREMAN_TOKEN -u FOREMAN_HOME -u FOREMAN_CLI_NAME sh test/smoke.sh
    # then: grep 'never started' <logs dir>/taskd.log

## Reproduction of the other checks

- Suite: `bunx tsc --noEmit && bun test` (unset `FOREMAN_*` when inside a worker).
- Migration: see the commands at the top of `migration-copy.txt`, i.e. back up the live DB with
  `sqlite3 -readonly`, then open `Store` twice with `FOREMAN_HOME=<copy dir>`.
- E2E: `zsh specs/t0057-cost-accounting-top-dashboard/qa/scripts/e2e.sh $PWD`.
- Dashboard: `zsh specs/t0057-cost-accounting-top-dashboard/qa/test-round-1/scripts/dashboard-browser.sh $PWD <out dir>`.
  This needs Google Chrome and uses ports 17957 and 17958. The proxy only pre-opens the cards and
  can fail `/costs/today`; it does not change the dashboard code.

## Changes in this step

- `test/cost-accounting.test.ts`: AS-2 now asserts the `step.result_recovered` (`source: "transcript"`)
  event. AS-3 now asserts `status = failed` and one `step.never_started` event. These are tests only;
  no production code changed.

## Notes for the handoff

- taskd still runs the old code. It needs a restart (`foreman service restart`), and the
  `cost_deltas_v1` migration then runs once on the live DB (on today's copy: 490 steps,
  826.48 → 674.97).
- Smoke's 5 s lease is tighter than tab shell startup on a loaded host. Consider a follow-up to
  raise smoke's `lease_sec`, or skip herdr in smoke when load is high.
