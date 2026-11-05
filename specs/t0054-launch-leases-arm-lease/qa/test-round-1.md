# T0054 test, round 1

**Verdict: pass.** All of AS-1 to AS-11 are covered by automated tests that pass. Verification mode is inspect, so there is no device or e2e suite and no platform matrix: flows run 0, passed 0, failed 0, skipped 0.

## Commands and results

| Command | Result | Evidence |
|---|---|---|
| `bunx tsc --noEmit` | clean, exit 0 | `test-round-1/tsc.txt` |
| `bun test test/` | 162 pass, 0 fail, 916 expect() calls, 14 files | `test-round-1/bun-test.txt` |
| `bun test test/launch.test.ts test/herdr-timeout.test.ts test/stall.test.ts test/result-recovery.test.ts` | 19 pass, 0 fail | `test-round-1/t0054-focused.txt` |

The "advance … failed" lines in `bun-test.txt` are expected log output from other test files, which remove their projects from config. They are not failures.

## Scenario coverage

| Scenario | Test | Result |
|---|---|---|
| AS-1 T0049 reproduction (stub tab create sleeps, `lease_sec=1`) | `launch.test.ts` "AS-1 …" | pass |
| AS-2 tick not stalled; the same tick expires another lease | `launch.test.ts` "AS-2 …" (tick < 1 s) | pass |
| AS-3 launch grace; late tab closed; step stays failed | `launch.test.ts` "AS-3 …" | pass |
| AS-4 relaunch with the same session and prompt; bound of 3; real+2 never-started does not fail the task | `launch.test.ts` "AS-4 …" | pass |
| AS-5 herdr throws, not counted | `launch.test.ts` "AS-5 …" | pass |
| AS-6 `run()` timeout (unit) | `herdr-timeout.test.ts` (tab create, workspace list; pane-run failure closes the tab) | pass |
| AS-6 through taskd: step error text | **added this round:** `launch.test.ts` "AS-6 through taskd …" checks the exact text `runner never started: herdr tab create timed out after 1s`, that it is not counted, and that it finishes in < 3 s | pass |
| AS-7 check-in arms the lease; later expiry is counted | `launch.test.ts` "AS-7 …" | pass |
| AS-7 `task show` line | **added this round:** `launch.test.ts` "AS-7 task show …" runs the real CLI against the real `route` and checks `runner seen … ago`, `runner not seen yet (launch started … ago)`, and that a non-running step has no line | pass |
| AS-8 no check-in after launch | `launch.test.ts` "AS-8 …" | pass |
| AS-9 sleep (600 s gap extends leases, `taskd.stall`); 2 s gap control expires the step | `stall.test.ts` | pass |
| AS-10 T0037 plan#2 recovery (cost 2.738647, 36 turns, summary, `recovered_from`, event source); non-result and truncated last lines expire as before; report.json path records `source: report` | `result-recovery.test.ts` | pass |
| AS-11 tsc and the full suite | see above | pass |
| S2 runner checks in before `mkdirSync(runDir)` and exits on `cancel` | inspected the diff, `test-round-1/runner-checkin.diff` | as specified |
| README "Launch and leases" (config keys, restart safe while steps run) | `test-round-1/readme-excerpt.txt`, README lines 215–255 | present |

## Observations (non-blocking, already raised in review round 1)

- F1 (token leak) shows up in this round's test log. The AS-5 path logs `launch failed … --env FOREMAN_TOKEN=<token> … failed (1): boom`, and the same text goes into `steps.error`. This is the behaviour from before the branch, and review round 1 filed it as a follow-up. It does not fail any acceptance scenario.

## Reproduction

```
bunx tsc --noEmit
bun test test/
bun test test/launch.test.ts   # 9 tests, including the 2 added this round
```

No failures to reproduce.
